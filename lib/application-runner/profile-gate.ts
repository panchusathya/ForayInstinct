import { readCandidateProfile } from "@/db/services/candidate-profile";
import { readOrImportDefaultResume } from "@/db/services/default-resume";
import type { AccessScope } from "@/lib/access-scope";
import { missingProfileFields } from "@/lib/candidate-profile";
import { applicationPauseMessage } from "@/lib/task-completion";

/**
 * The blocking facts a run would have to interrogate the candidate for.
 *
 * Deliberately the same `missingProfileFields` the `candidate_profile` tool
 * reports, so the agent can never satisfy the list it was given and still be
 * refused, or be refused for something it was never told to ask about.
 *
 * Fails open in both directions. The gate exists to skip a run that cannot
 * succeed, not to invent a refusal when a dependency is down: a resume lookup
 * that throws counts as a resume on file, and an unreadable profile starts the
 * application exactly as it would have before this check existed.
 */
export async function missingProfileFacts(
  scope: AccessScope
): Promise<string[]> {
  try {
    const [profile, hasResume] = await Promise.all([
      readCandidateProfile(scope),
      // The same call the fill makes to stage the file, so this warms the local
      // copy rather than costing a round trip. `hasDefaultResume` would only
      // see the local table and would tell a candidate whose resume lives in
      // JuiceBox to type their legal name into chat.
      readOrImportDefaultResume(scope).then(
        (document) => document !== undefined,
        () => true
      ),
    ]);
    return missingProfileFields(profile, { hasResume });
  } catch {
    return [];
  }
}

/** Candidate-facing copy naming every gap at once, never one per message. */
export function profileGateMessage(missing: string[], role: string) {
  return applicationPauseMessage(
    "user_input",
    `before starting ${role} the profile is missing: ${missing.join("; ")}. Save them with candidate_profile, then start again.`
  );
}
