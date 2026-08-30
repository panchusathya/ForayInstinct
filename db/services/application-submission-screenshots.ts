import { and, desc, eq, isNull } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { applicationSubmissionScreenshots, db } from "@/db";

const pngMimeType = "image/png";

export async function saveApplicationSubmissionScreenshot(
  scope: AccessScope,
  sessionId: string,
  screenshot: {
    page?: string;
    png: Buffer;
  }
) {
  if (screenshot.png.byteLength === 0) return;
  await db.insert(applicationSubmissionScreenshots).values({
    createdAt: new Date().toISOString(),
    createdByUserId: scope.userId,
    mimeType: pngMimeType,
    page: screenshot.page,
    pngBase64: screenshot.png.toString("base64"),
    sessionId,
    workspaceId: scope.workspaceId,
  });
}

export async function consumeLatestApplicationSubmissionScreenshot(
  scope: AccessScope
) {
  return db.transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        id: applicationSubmissionScreenshots.id,
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
      .orderBy(desc(applicationSubmissionScreenshots.createdAt))
      .limit(1);
    if (!row) return undefined;

    const [claimed] = await transaction
      .update(applicationSubmissionScreenshots)
      .set({ deliveredAt: new Date().toISOString() })
      .where(
        and(
          eq(applicationSubmissionScreenshots.id, row.id),
          isNull(applicationSubmissionScreenshots.deliveredAt)
        )
      )
      .returning({
        id: applicationSubmissionScreenshots.id,
      });
    if (!claimed) return undefined;

    return {
      mimeType: row.mimeType,
      png: Buffer.from(row.pngBase64, "base64"),
    };
  });
}
