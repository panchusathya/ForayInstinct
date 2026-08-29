import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
  saveCandidateProfile,
} from "@/db/services/candidate-profile";
import { scopeFromPrincipal } from "@/lib/access-scope";
import {
  candidateProfilePatchSchema,
  candidateProfileSummary,
  missingProfileFields,
} from "@/lib/candidate-profile";

/**
 * The candidate's reusable ATS profile (work history, education, authorization).
 * Returns a pre-rendered assignment block rather than a raw object so the
 * coordinator can paste it into the worker assignment without paraphrasing.
 */
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
            const stored =
              action === "save"
                ? (
                    await saveCandidateProfile(scope, profile ?? {})
                  ).profile
                : await readCandidateProfile(scope);
            const identity = await readCandidateContactIdentity(scope);
            const summary = candidateProfileSummary(stored, identity, {
              allPositions,
            });
            return {
              assignment: summary.text,
              missing: missingProfileFields(stored),
              truncated: summary.truncated,
            };
          },
        }),
      };
    },
  },
});
