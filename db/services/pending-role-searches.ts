import { eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, goforayPendingRoleSearches } from "@/db";

export async function rememberLinqRoleSearchThread(
  scope: AccessScope,
  threadId: string,
  phone?: string
) {
  await db
    .insert(goforayPendingRoleSearches)
    .values({
      phone: phone ?? "",
      threadId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: goforayPendingRoleSearches.workspaceId,
      set: {
        phone: phone ?? "",
        threadId,
        updatedAt: new Date(),
        userId: scope.userId,
      },
    });
}

/**
 * Marks the thread's search as one the poller should finish. Nothing wrote
 * this before, so the poller that delivers a background search's cards was
 * never given anything to deliver.
 */
export async function markPendingRoleSearch(
  scope: AccessScope,
  search: { location: string; query: string }
) {
  await db
    .update(goforayPendingRoleSearches)
    .set({
      location: search.location,
      pending: "yes",
      query: search.query,
      updatedAt: new Date(),
      userId: scope.userId,
    })
    .where(eq(goforayPendingRoleSearches.workspaceId, scope.workspaceId));
}

/** The latest candidate thread is also where browser review media belongs. */
export async function findLinqThread(scope: AccessScope) {
  const [row] = await db
    .select({ threadId: goforayPendingRoleSearches.threadId })
    .from(goforayPendingRoleSearches)
    .where(eq(goforayPendingRoleSearches.workspaceId, scope.workspaceId))
    .limit(1);
  return row?.threadId;
}

export async function listPendingRoleSearches(limit = 20) {
  return db
    .select()
    .from(goforayPendingRoleSearches)
    .where(eq(goforayPendingRoleSearches.pending, "yes"))
    .orderBy(goforayPendingRoleSearches.updatedAt)
    .limit(limit);
}

export async function completePendingRoleSearch(workspaceId: string) {
  await db
    .update(goforayPendingRoleSearches)
    .set({ pending: "", updatedAt: new Date() })
    .where(eq(goforayPendingRoleSearches.workspaceId, workspaceId));
}
