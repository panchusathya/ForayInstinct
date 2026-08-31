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
    .values({ phone: phone ?? "", threadId, workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: goforayPendingRoleSearches.workspaceId,
      set: { phone: phone ?? "", threadId, updatedAt: new Date() },
    });
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
