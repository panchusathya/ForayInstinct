import { eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, workspaces } from "@/db";

export async function readWorkspaceKernelProfileId(scope: AccessScope) {
  const rows = await db
    .select({ kernelProfileId: workspaces.kernelProfileId })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId))
    .limit(1);
  return rows[0]?.kernelProfileId ?? "";
}

export async function saveWorkspaceKernelProfileId(
  scope: AccessScope,
  kernelProfileId: string
): Promise<{ stored: boolean }> {
  try {
    const updated = await db
      .update(workspaces)
      .set({ kernelProfileId })
      .where(eq(workspaces.id, scope.workspaceId))
      .returning({ id: workspaces.id });
    return { stored: updated.length > 0 };
  } catch (error) {
    console.error("[kernel-profile] persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return { stored: false };
  }
}
