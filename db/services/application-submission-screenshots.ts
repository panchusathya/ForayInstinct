import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { applicationSubmissionScreenshots, db } from "@/db";

const pngMimeType = "image/png";

/**
 * `review` is the completed form the candidate is asked to check before the
 * submit control is activated; `submitted` is proof the ATS accepted it.
 */
export type ApplicationSubmissionScreenshotKind = "review" | "submitted";

export async function saveApplicationSubmissionScreenshot(
  scope: AccessScope,
  sessionId: string,
  screenshot: {
    kind: ApplicationSubmissionScreenshotKind;
    page?: string;
    png: Buffer;
  }
) {
  if (screenshot.png.byteLength === 0) return;
  await db.insert(applicationSubmissionScreenshots).values({
    createdAt: new Date().toISOString(),
    createdByUserId: scope.userId,
    kind: screenshot.kind,
    mimeType: pngMimeType,
    page: screenshot.page,
    pngBase64: screenshot.png.toString("base64"),
    sessionId,
    workspaceId: scope.workspaceId,
  });
}

/**
 * A scroll-stitched review is several rows, so claim every pending row rather
 * than the newest one: delivering only the last capture would silently drop
 * the top of the form the candidate is being asked to approve. Rows come back
 * oldest first so the thread reads down the page. Claiming inside the
 * transaction keeps two concurrent turns from posting the same image twice.
 */
export async function consumePendingApplicationSubmissionScreenshots(
  scope: AccessScope
) {
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        id: applicationSubmissionScreenshots.id,
        kind: applicationSubmissionScreenshots.kind,
        mimeType: applicationSubmissionScreenshots.mimeType,
        pngBase64: applicationSubmissionScreenshots.pngBase64,
      })
      .from(applicationSubmissionScreenshots)
      .where(
        and(
          eq(applicationSubmissionScreenshots.workspaceId, scope.workspaceId),
          isNull(applicationSubmissionScreenshots.deliveredAt)
        )
      )
      .orderBy(asc(applicationSubmissionScreenshots.createdAt));
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
        kind: row.kind,
        mimeType: row.mimeType,
        png: Buffer.from(row.pngBase64, "base64"),
      }));
  });
}
