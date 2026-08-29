import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, settings } from "@/db";
import {
  type SelfIdentification,
  selfIdentificationSchema,
} from "@/lib/self-identification";

const selfIdentificationKey = "self_identification";

export async function readSelfIdentification(
  scope: AccessScope
): Promise<SelfIdentification> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.workspaceId, scope.workspaceId),
        eq(settings.key, selfIdentificationKey)
      )
    )
    .limit(1);
  const stored = rows[0]?.value;
  if (stored === undefined) return {};
  // Stored answers are rewritten by later saves, so tolerate an older shape
  // rather than failing an application over it.
  try {
    return selfIdentificationSchema.catch({}).parse(JSON.parse(stored));
  } catch {
    return {};
  }
}

/** Merges the supplied answers over the stored ones and returns the result. */
export async function saveSelfIdentification(
  scope: AccessScope,
  answers: SelfIdentification
): Promise<SelfIdentification> {
  const merged = { ...(await readSelfIdentification(scope)), ...answers };
  const value = JSON.stringify(merged);
  await db
    .insert(settings)
    .values({
      key: selfIdentificationKey,
      value,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value },
    });
  return merged;
}
