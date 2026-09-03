import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
  saveCandidateProfile,
} from "@/db/services/candidate-profile";
import { hasDefaultResume } from "@/db/services/candidate-documents";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  candidateProfilePatchSchema,
  type CandidateProfilePatch,
  candidateProfileSummary,
  missingProfileFields,
  profilePatchOf,
} from "@/lib/candidate-profile";

/**
 * The candidate's reusable ATS profile (work history, education, authorization).
 * Returns a pre-rendered assignment block rather than a raw object so the
 * coordinator can paste it into the worker assignment without paraphrasing.
 */
/**
 * Drops the blanks out of a save.
 *
 * This tool only ever carries facts the candidate stated, so an empty value
 * means the model had nothing rather than that the candidate cleared
 * something. Passing those through let one save wipe an answer an earlier save
 * had captured, and the profile went backwards between applications. Clearing
 * a field deliberately belongs to the profile page, which sends its full
 * intended state.
 */
function statedFacts(patch: CandidateProfilePatch | undefined) {
  if (!patch) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    kept[key] = value;
  }
  return profilePatchOf(kept);
}

export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        candidate_profile: defineTool({
          description:
            'Read or save the candidate\'s reusable job-application profile (name, location, work authorization, compensation, work history, education, skills). Use "get" before delegating an ATS application and paste the returned `assignment` into the worker assignment. Use "save" only with facts the candidate stated themselves. `missing` is the list of labels to ask once, then save, then resume. Pass all_positions: true on get only when the compact history is truncated.',
          inputSchema: z.object({
            action: z.enum(["get", "save"]),
            all_positions: z.boolean().optional(),
            profile: candidateProfilePatchSchema.optional(),
          }),
          async execute({ action, all_positions: allPositions, profile }) {
            const patch = action === "save" ? statedFacts(profile) : undefined;
            const stored =
              patch && Object.keys(patch).length > 0
                ? (await saveCandidateProfile(scope, patch)).profile
                : await readCandidateProfile(scope);
            const [identity, hasResume] = await Promise.all([
              readCandidateContactIdentity(scope),
              hasDefaultResume(scope),
            ]);
            const summary = candidateProfileSummary(stored, identity, {
              allPositions,
            });
            return {
              assignment: summary.text,
              missing: missingProfileFields(stored, { hasResume }),
              truncated: summary.truncated,
            };
          },
        }),
      };
    },
  },
});
