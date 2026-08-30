import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readCandidateProfile } from "@/db/services/candidate-profile";
import { readCandidateResume } from "@/db/services/candidate-resume";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { resumeFillableProfileGaps } from "@/lib/candidate-profile";

/**
 * The text of the candidate's own resume, kept so a written answer about their
 * experience is grounded in what they actually did. The file itself still goes
 * to an ATS through the worker; only this text reaches a model.
 *
 * `profile_gaps` names the profile sections this resume can fill, so
 * populating the durable profile is a stated instruction in the result rather
 * than something the coordinator has to remember to do.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);

      return {
        candidate_resume: defineTool({
          description:
            'Read the text of the candidate\'s stored resume. Call this before writing anything in their voice about their own background — a "why this company", "why this role", or "tell us about yourself" answer, a cover letter, or a summary field — and ground every claim in what it returns. When `profile_gaps` is not empty, call `candidate_profile` `save` in the same turn to fill exactly those sections from this text, so the next application already has them and the candidate is never asked to retype their own resume. `stored: false` means no resume is on file: ask for one rather than inventing experience. Never quote the whole resume back to the user, and never invent an employer, title, date, or achievement that is not in it.',
          inputSchema: z.object({}),
          async execute() {
            const [resume, profile] = await Promise.all([
              readCandidateResume(scope),
              readCandidateProfile(scope),
            ]);
            if (!resume) {
              return { profile_gaps: [], stored: false as const, text: "" };
            }
            return {
              filename: resume.filename,
              profile_gaps: resumeFillableProfileGaps(profile),
              stored: true as const,
              text: resume.text,
              updated_at: resume.updatedAt,
            };
          },
        }),
      };
    },
  },
});
