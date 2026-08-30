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

export async function queuePendingRoleSearch(
  scope: AccessScope,
  input: { location?: string; query?: string }
) {
  const existing = await db.query.goforayPendingRoleSearches.findFirst({
    where: eq(goforayPendingRoleSearches.workspaceId, scope.workspaceId),
  });
  if (!existing) return;
  await db
    .update(goforayPendingRoleSearches)
    .set({
      location: input.location?.trim() ?? "",
      pending: "yes",
      query: input.query?.trim() ?? "",
      updatedAt: new Date(),
    })
    .where(eq(goforayPendingRoleSearches.workspaceId, scope.workspaceId));
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
