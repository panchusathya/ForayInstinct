import { eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { candidateProfiles, db, user } from "@/db";
import {
  candidateProfilePatchSchema,
  candidateProfileSchema,
  emptyCandidateProfile,
  type CandidateContactIdentity,
  type CandidateProfile,
  type CandidateProfilePatch,
} from "@/lib/candidate-profile";

/**
 * Reads the workspace profile, or an empty profile when none is stored.
 * Tolerates a stale JSON shape. Never throws.
 */
export async function readCandidateProfile(
  scope: AccessScope
): Promise<CandidateProfile> {
  const rows = await db
    .select()
    .from(candidateProfiles)
    .where(eq(candidateProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return emptyCandidateProfile;
  return parseStoredProfile(row);
}

/**
 * Merges scalar fields over the stored profile and replaces any array the
 * caller supplies. There is no entry identity, so a partial save from one UI
 * section must send the full array for that section or it would duplicate
 * positions. A failed write returns `{ stored: false }` rather than throwing:
 * an in-flight application must not die with the profile insert.
 */
export async function saveCandidateProfile(
  scope: AccessScope,
  patch: CandidateProfilePatch
): Promise<{ profile: CandidateProfile; stored: boolean }> {
  const stored = await readCandidateProfile(scope);
  const parsedPatch = candidateProfilePatchSchema.parse(patch);
  const merged = candidateProfileSchema.parse({
    ...stored,
    ...parsedPatch,
  });
  const now = new Date().toISOString();
  try {
    await db
      .insert(candidateProfiles)
      .values({
        ...merged,
        createdAt: now,
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoUpdate({
        target: candidateProfiles.workspaceId,
        set: {
          ...merged,
          updatedAt: now,
        },
      });
    return { profile: merged, stored: true };
  } catch (error) {
    console.error("[candidate-profile] persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return { profile: merged, stored: false };
  }
}

/** Verified email/phone from the Better Auth user row, plus display name. */
export async function readCandidateContactIdentity(
  scope: AccessScope
): Promise<CandidateContactIdentity> {
  const rows = await db
    .select({
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      phoneNumber: user.phoneNumber,
      phoneNumberVerified: user.phoneNumberVerified,
    })
    .from(user)
    .where(eq(user.id, authUserId(scope.userId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { name: "" };
  return {
    name: row.name.trim(),
    ...(row.emailVerified && row.email ? { email: row.email } : {}),
    ...(row.phoneNumberVerified === true && row.phoneNumber
      ? { phone: row.phoneNumber }
      : {}),
  };
}

function parseStoredProfile(row: typeof candidateProfiles.$inferSelect) {
  return candidateProfileSchema.catch(emptyCandidateProfile).parse({
    earliestStartDate: row.earliestStartDate,
    education: row.education,
    headline: row.headline,
    legalFirstName: row.legalFirstName,
    legalLastName: row.legalLastName,
    links: row.links,
    locationCity: row.locationCity,
    locationCountryCode: row.locationCountryCode,
    locationPostalCode: row.locationPostalCode,
    locationRegion: row.locationRegion,
    preferredName: row.preferredName,
    requiresSponsorshipFuture: row.requiresSponsorshipFuture,
    requiresSponsorshipNow: row.requiresSponsorshipNow,
    salaryCurrency: row.salaryCurrency,
    salaryMax: row.salaryMax,
    salaryMin: row.salaryMin,
    salaryPeriod: row.salaryPeriod,
    skills: row.skills,
    summary: row.summary,
    willingToRelocate: row.willingToRelocate,
    workArrangement: row.workArrangement,
    workAuthorization: row.workAuthorization,
    workHistory: row.workHistory,
    yearsExperience: row.yearsExperience,
  });
}

function authUserId(userId: string) {
  return userId.replace(/^better-auth:/u, "");
}
