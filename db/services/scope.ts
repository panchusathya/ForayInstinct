import { asc, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, workspaceMemberships, workspaces } from "@/db";

export async function ensureScope(scope: AccessScope) {
  const createdAt = new Date().toISOString();
  await db.transaction(async (transaction) => {
    await transaction
      .insert(workspaces)
      .values({ createdAt, id: scope.workspaceId })
      .onConflictDoNothing({ target: workspaces.id });
    await transaction
      .insert(workspaceMemberships)
      .values({
        createdAt,
        role: "owner",
        userId: scope.userId,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      });
  });
}

/**
 * The user a workspace was created for: its earliest member. For an outbox
 * row written before the writer was recorded, the only user id left to sign
 * the CRM mirror with.
 */
export async function findWorkspaceOwnerUserId(workspaceId: string) {
  const [row] = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .orderBy(asc(workspaceMemberships.createdAt))
    .limit(1);
  return row?.userId;
}
