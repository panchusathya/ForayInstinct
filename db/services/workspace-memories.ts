import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, workspaceMemories } from "@/db";
import { ensureScope } from "./scope";

const maxMemories = 40;
const memoryKeyPattern = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;

export async function listWorkspaceMemories(scope: AccessScope) {
  return db
    .select({
      key: workspaceMemories.key,
      updatedAt: workspaceMemories.updatedAt,
      value: workspaceMemories.value,
    })
    .from(workspaceMemories)
    .where(eq(workspaceMemories.workspaceId, scope.workspaceId));
}

export async function saveWorkspaceMemory(
  scope: AccessScope,
  key: string,
  value: string
) {
  const normalizedKey = key.trim().toLowerCase();
  if (!memoryKeyPattern.test(normalizedKey)) {
    throw new Error(
      "Memory keys use lowercase letters, numbers, dots, underscores, or dashes."
    );
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new Error("Memory values cannot be empty.");
  }
  if (normalizedValue.length > 2_000) {
    throw new Error("Keep a remembered fact under 2,000 characters.");
  }

  const existing = await listWorkspaceMemories(scope);
  if (
    existing.length >= maxMemories &&
    !existing.some((entry) => entry.key === normalizedKey)
  ) {
    throw new Error("This workspace already has 40 remembered facts.");
  }

  await ensureScope(scope);
  const now = new Date().toISOString();
  await db
    .insert(workspaceMemories)
    .values({
      key: normalizedKey,
      updatedAt: now,
      value: normalizedValue,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [workspaceMemories.workspaceId, workspaceMemories.key],
      set: { updatedAt: now, value: normalizedValue },
    });
  return { key: normalizedKey, value: normalizedValue };
}

export async function deleteWorkspaceMemory(scope: AccessScope, key: string) {
  await db
    .delete(workspaceMemories)
    .where(
      and(
        eq(workspaceMemories.workspaceId, scope.workspaceId),
        eq(workspaceMemories.key, key.trim().toLowerCase())
      )
    );
}
