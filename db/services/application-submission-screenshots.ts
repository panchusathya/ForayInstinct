import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import {
  imageMimeType,
  maxClaimedSubmissionScreenshots,
} from "@/lib/browser-submission";
import {
  applicationExecutions,
  applicationSubmissionScreenshots,
  db,
} from "@/db";

/**
 * How long an undelivered capture is still worth showing. A thread that reads
 * as SMS keeps its rows pending so a later iMessage turn can deliver them, so
 * the queue needs an outer bound.
 */
const pendingScreenshotTtlMs = 7 * 24 * 60 * 60 * 1000;

/**
 * `review` is the completed form the candidate is asked to check before the
 * submit control is activated; `submitted` is proof the ATS accepted it.
 */
export type ApplicationSubmissionScreenshotKind = "review" | "submitted";

/** One capture of its own: a confirmation screen, or a legacy single save. */
export async function saveApplicationSubmissionScreenshot(
  scope: AccessScope,
  sessionId: string,
  screenshot: {
    applyUrl?: string;
    kind: ApplicationSubmissionScreenshotKind;
    page?: string;
    png: Buffer;
    role?: string;
  }
) {
  await saveApplicationSubmissionScreenshotBatch(scope, sessionId, {
    ...screenshot,
    pngs: [screenshot.png],
  });
}

/**
 * One capture set, written in one statement. A review is several screenshots
 * of one form; written a row at a time, a claim that landed between two
 * writes took a page of five as the whole review. Every row of a set shares
 * the batch id the claim takes whole.
 */
export async function saveApplicationSubmissionScreenshotBatch(
  scope: AccessScope,
  sessionId: string,
  screenshots: {
    applyUrl?: string;
    kind: ApplicationSubmissionScreenshotKind;
    page?: string;
    pngs: readonly Buffer[];
    role?: string;
  }
) {
  const batchId = `${sessionId}:${randomUUID()}`;
  const pngs = screenshots.pngs.filter((png) => png.byteLength > 0);
  if (pngs.length === 0) return { batchId, count: 0 };
  const createdAt = new Date().toISOString();
  await db.insert(applicationSubmissionScreenshots).values(
    pngs.map((png) => ({
      applyUrl: screenshots.applyUrl ?? "",
      batchId,
      createdAt,
      createdByUserId: scope.userId,
      kind: screenshots.kind,
      mimeType: imageMimeType(png),
      page: screenshots.page,
      pngBase64: png.toString("base64"),
      role: screenshots.role ?? "",
      sessionId,
      workspaceId: scope.workspaceId,
    }))
  );
  return { batchId, count: pngs.length };
}

export interface ClaimSubmissionScreenshotsFilter {
  applyUrl?: string;
  batchId?: string;
  executionId?: string;
}

/**
 * Claims one application's pending screenshots for delivery.
 *
 * Batched by apply URL (or execution id, which resolves to that URL), not by
 * the workspace's newest browser session: two applications in flight must not
 * be posted as one numbered run, and a just-captured review must not suppress
 * the other posting's approval ask. Rows written before attribution have an
 * empty apply URL and still group by session.
 *
 * Bounded by `maxClaimedSubmissionScreenshots` because every row carries its PNG
 * as base64 text: selecting every pending row in the workspace pulled all of
 * them into memory at once.
 *
 * Claiming inside the transaction keeps two concurrent turns from posting the
 * same image twice. The claim is the `deliveredAt` stamp, so a caller that
 * fails to post **must** hand the ids back to
 * `releaseApplicationSubmissionScreenshots`; otherwise the review the candidate
 * is being asked to approve is silently dropped.
 */
export async function claimPendingApplicationSubmissionScreenshots(
  scope: AccessScope,
  filter: ClaimSubmissionScreenshotsFilter = {},
  limit = maxClaimedSubmissionScreenshots
) {
  return db.transaction(async (transaction) => {
    // A thread that never reads as rich leaves its rows pending on purpose, so
    // a later turn can still deliver them. Without an expiry that queue only
    // grows, and a months-old form is not something to ask approval for
    // anyway. Retire them rather than deleting: the row is still the record
    // that a capture was taken.
    await transaction
      .update(applicationSubmissionScreenshots)
      .set({ deliveredAt: new Date().toISOString() })
      .where(
        and(
          eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
          isNull(applicationSubmissionScreenshots.deliveredAt),
          lt(
            applicationSubmissionScreenshots.createdAt,
            new Date(Date.now() - pendingScreenshotTtlMs).toISOString()
          )
        )
      );

    let applyUrl = filter.applyUrl?.trim() ?? "";
    if (applyUrl === "" && filter.executionId) {
      const [execution] = await transaction
        .select({ applyUrl: applicationExecutions.applyUrl })
        .from(applicationExecutions)
        .where(
          and(
            eq(applicationExecutions.workspaceId, scope.workspaceId),
            eq(applicationExecutions.id, filter.executionId)
          )
        )
        .limit(1);
      applyUrl = execution?.applyUrl ?? "";
    }

    // The set to claim: a named batch; else the application named, or the
    // newest pending one. An application's rows are complete sets now that
    // each set is written in one statement, so they can travel together and
    // number their pages among themselves.
    const batchId = filter.batchId?.trim() ?? "";
    const [newest] =
      batchId === "" && applyUrl === ""
        ? await transaction
            .select({
              applyUrl: applicationSubmissionScreenshots.applyUrl,
              batchId: applicationSubmissionScreenshots.batchId,
              sessionId: applicationSubmissionScreenshots.sessionId,
            })
            .from(applicationSubmissionScreenshots)
            .where(
              and(
                eq(
                  applicationSubmissionScreenshots.workspaceId,
                  scope.workspaceId
                ),
                isNull(applicationSubmissionScreenshots.deliveredAt)
              )
            )
            .orderBy(
              desc(applicationSubmissionScreenshots.createdAt),
              desc(applicationSubmissionScreenshots.id)
            )
            .limit(1)
        : [];
    if (batchId === "" && applyUrl === "" && !newest) return [];

    const batchApplyUrl = applyUrl === "" ? (newest?.applyUrl ?? "") : applyUrl;
    const setPredicate =
      batchId !== ""
        ? eq(applicationSubmissionScreenshots.batchId, batchId)
        : batchApplyUrl !== ""
          ? eq(applicationSubmissionScreenshots.applyUrl, batchApplyUrl)
          : // A row that names no posting (a legacy capture, or a confirmation
            // saved from the checkpoint trail) travels with the rest of its
            // browser session, as it always did.
            eq(
              applicationSubmissionScreenshots.sessionId,
              newest?.sessionId ?? ""
            );
    const rows = await transaction
      .select({
        applyUrl: applicationSubmissionScreenshots.applyUrl,
        batchId: applicationSubmissionScreenshots.batchId,
        id: applicationSubmissionScreenshots.id,
        kind: applicationSubmissionScreenshots.kind,
        mimeType: applicationSubmissionScreenshots.mimeType,
        pngBase64: applicationSubmissionScreenshots.pngBase64,
        role: applicationSubmissionScreenshots.role,
        sessionId: applicationSubmissionScreenshots.sessionId,
      })
      .from(applicationSubmissionScreenshots)
      .where(
        and(
          eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
          isNull(applicationSubmissionScreenshots.deliveredAt),
          setPredicate
        )
      )
      .orderBy(
        asc(applicationSubmissionScreenshots.createdAt),
        asc(applicationSubmissionScreenshots.id)
      )
      .limit(limit);
    if (rows.length === 0) return [];

    const claimed = await transaction
      .update(applicationSubmissionScreenshots)
      .set({ deliveredAt: new Date().toISOString() })
      .where(
        and(
          inArray(
            applicationSubmissionScreenshots.id,
            rows.map((row) => row.id)
          ),
          isNull(applicationSubmissionScreenshots.deliveredAt)
        )
      )
      .returning({ id: applicationSubmissionScreenshots.id });
    const claimedIds = new Set(claimed.map((row) => row.id));

    return rows
      .filter((row) => claimedIds.has(row.id))
      .map((row) => ({
        applyUrl: row.applyUrl,
        batchId: row.batchId,
        id: row.id,
        kind: row.kind,
        mimeType: row.mimeType,
        png: Buffer.from(row.pngBase64, "base64"),
        role: row.role,
        sessionId: row.sessionId,
      }));
  });
}

/**
 * Returns claimed rows to the queue after a failed delivery, so the review is
 * re-offered on the next turn instead of being lost. Workspace-scoped, and only
 * ever clears a stamp this workspace's own claim set.
 */
export async function releaseApplicationSubmissionScreenshots(
  scope: AccessScope,
  ids: readonly number[]
) {
  if (ids.length === 0) return;
  await db
    .update(applicationSubmissionScreenshots)
    .set({ deliveredAt: null })
    .where(
      and(
        eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
        inArray(applicationSubmissionScreenshots.id, [...ids])
      )
    );
}

/**
 * The screenshot table is also the delivery outbox. A background dispatcher
 * and the inbound webhook deliver every pending set, each on its own, oldest
 * first, so two applications in flight arrive as two captioned reviews and
 * not as whichever is newest. One entry per pending application (or, for a
 * row that names none, per batch), with the scope that owns it.
 */
export async function listPendingApplicationSubmissionScreenshotBatches(
  limit = 25,
  scope?: AccessScope
): Promise<
  { applyUrl: string; batchId: string; kind: string; scope: AccessScope }[]
> {
  const rows = await db
    .select({
      applyUrl: applicationSubmissionScreenshots.applyUrl,
      batchId: applicationSubmissionScreenshots.batchId,
      kind: applicationSubmissionScreenshots.kind,
      userId: applicationSubmissionScreenshots.createdByUserId,
      workspaceId: applicationSubmissionScreenshots.workspaceId,
    })
    .from(applicationSubmissionScreenshots)
    .where(
      scope
        ? and(
            eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
            isNull(applicationSubmissionScreenshots.deliveredAt)
          )
        : isNull(applicationSubmissionScreenshots.deliveredAt)
    )
    .orderBy(
      asc(applicationSubmissionScreenshots.createdAt),
      asc(applicationSubmissionScreenshots.id)
    )
    .limit(limit * 8);
  const batches: {
    applyUrl: string;
    batchId: string;
    kind: string;
    scope: AccessScope;
  }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.applyUrl === "" ? row.batchId : row.applyUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    batches.push({
      applyUrl: row.applyUrl,
      batchId: row.batchId,
      kind: row.kind,
      scope: { userId: row.userId, workspaceId: row.workspaceId },
    });
    if (batches.length === limit) break;
  }
  return batches;
}
