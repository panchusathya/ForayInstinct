import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { maxClaimedSubmissionScreenshots } from "@/lib/browser-submission";
import { applicationSubmissionScreenshots, db } from "@/db";

const pngMimeType = "image/png";

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
  if (screenshot.png.byteLength === 0) return;
  await db.insert(applicationSubmissionScreenshots).values({
    applyUrl: screenshot.applyUrl ?? "",
    createdAt: new Date().toISOString(),
    createdByUserId: scope.userId,
    kind: screenshot.kind,
    mimeType: pngMimeType,
    page: screenshot.page,
    pngBase64: screenshot.png.toString("base64"),
    role: screenshot.role ?? "",
    sessionId,
    workspaceId: scope.workspaceId,
  });
}

/**
 * Claims one application's pending screenshots for delivery.
 *
 * Scoped to a single browser session, newest first: a scroll-stitched review is
 * several rows and the candidate has to read down the page, but two
 * applications in flight must not be posted as one numbered run under a caption
 * that names neither. Selecting the newest session ensures a just-captured
 * review is never displaced by a stale delivery retry from an earlier form.
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

    const [newest] = await transaction
      .select({ sessionId: applicationSubmissionScreenshots.sessionId })
      .from(applicationSubmissionScreenshots)
      .where(
        and(
          eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
          isNull(applicationSubmissionScreenshots.deliveredAt)
        )
      )
      .orderBy(desc(applicationSubmissionScreenshots.createdAt))
      .limit(1);
    if (!newest) return [];

    const rows = await transaction
      .select({
        applyUrl: applicationSubmissionScreenshots.applyUrl,
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
          eq(applicationSubmissionScreenshots.sessionId, newest.sessionId),
          isNull(applicationSubmissionScreenshots.deliveredAt)
        )
      )
      .orderBy(asc(applicationSubmissionScreenshots.createdAt))
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
