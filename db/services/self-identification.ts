import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { db, settings } from "@/db";
import {
  type SelfIdentification,
  selfIdentificationSchema,
} from "@/lib/self-identification";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
} from "./candidate-profile";

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

/**
 * Merges the supplied answers over the stored ones and returns the result.
 *
 * Storing them only saves the candidate from being asked the same question on
 * the next application, so a failed write is reported rather than thrown: an
 * application already waiting on the answer must not die with the insert. A
 * `settings_key_check` that admitted only `gateway_model` did exactly that.
 */
export async function saveSelfIdentification(
  scope: AccessScope,
  answers: SelfIdentification
): Promise<{ answers: SelfIdentification; stored: boolean }> {
  const merged = { ...(await readSelfIdentification(scope)), ...answers };
  const value = JSON.stringify(merged);
  try {
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
    return { answers: merged, stored: true };
  } catch (error) {
    console.error("[self-identification] persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return { answers: merged, stored: false };
  }
}

/**
 * The name the candidate signs a disability self-identification form with:
 * the legal name on their profile, else the name on their login. It used to
 * look the scope's user id up in the Better Auth table, where a prefixed or
 * phone-derived id never matched, so every form was signed with "".
 */
export async function readSelfIdentificationSignatureName(
  scope: AccessScope
): Promise<string> {
  const profile = await readCandidateProfile(scope);
  const legal = `${profile.legalFirstName} ${profile.legalLastName}`.trim();
  if (legal !== "") return legal;
  return (await readCandidateContactIdentity(scope)).name;
}
