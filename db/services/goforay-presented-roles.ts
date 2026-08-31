import { desc, eq } from "drizzle-orm";
import { db, goforayWorkspacePresentedRoles } from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import type { GoForayJobCard } from "@/lib/goforay/job-cards";
import { normalizeJobUrl, roleKey } from "@/lib/goforay/role-identity";
import { ensureScope } from "./scope";

/**
 * Roles this workspace has already been shown.
 *
 * Both functions are deliberately fail-safe: dedupe is bookkeeping, and a
 * bookkeeping fault must never take the role search down with it. A failure
 * degrades to "nothing recorded yet", which repeats a role at worst.
 */

export async function listPresentedRoles(scope: AccessScope, limit = 300) {
  try {
    const rows = await db
      .select({
        postingId: goforayWorkspacePresentedRoles.postingId,
        roleKey: goforayWorkspacePresentedRoles.roleKey,
        url: goforayWorkspacePresentedRoles.url,
      })
      .from(goforayWorkspacePresentedRoles)
      .where(eq(goforayWorkspacePresentedRoles.workspaceId, scope.workspaceId))
      .orderBy(desc(goforayWorkspacePresentedRoles.createdAt))
      .limit(limit);
    return {
      // Both identities, not just the primary key. A row stored as
      // `posting:<id>` also holds its normalized URL, and that is the only form
      // a public hit for the same posting can be recognised by. Reading one
      // column and writing two is what let an already-shown role come back.
      keys: new Set(
        rows.flatMap((row) =>
          row.url ? [row.roleKey, `url:${row.url}`] : [row.roleKey]
        )
      ),
      postingIds: rows
        .map((row) => row.postingId)
        .filter((postingId) => postingId.length > 0),
    };
  } catch (error) {
    console.error("[goforay] presented-role store unavailable", {
      message: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return { keys: new Set<string>(), postingIds: [] as string[] };
  }
}

export async function rememberPresentedRoles(
  scope: AccessScope,
  cards: readonly GoForayJobCard[]
) {
  if (!cards.length) return;
  try {
    await ensureScope(scope);
    // One statement rather than one per card: a search records its whole batch.
    const rows = [
      ...new Map(
        cards.map((card) => [
          roleKey(card),
          {
            postingId: card.posting_id?.trim() ?? "",
            roleKey: roleKey(card),
            url: normalizeJobUrl(card.url),
            workspaceId: scope.workspaceId,
          },
        ])
      ).values(),
    ];
    await db
      .insert(goforayWorkspacePresentedRoles)
      .values(rows)
      .onConflictDoNothing();
  } catch (error) {
    console.error("[goforay] presented-role store unavailable", {
      message: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
  }
}
