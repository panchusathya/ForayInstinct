import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readCandidateResume } from "@/db/services/candidate-resume";
import { scopeFromPrincipal } from "@/lib/access-scope";

/**
 * The text of the candidate's own resume, kept so a written answer about their
 * experience is grounded in what they actually did. The file itself still goes
 * to an ATS through the worker; only this text reaches a model.
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
            'Read the text of the candidate\'s stored resume. Call this before writing anything in their voice about their own background — a "why this company", "why this role", or "tell us about yourself" answer, a cover letter, or a summary field — and ground every claim in what it returns. Also call it when the candidate profile is missing work history or skills, so you can fill those in from the resume with candidate_profile save instead of asking them to retype it. Returns `stored: false` when no resume has been uploaded yet; then ask the candidate rather than inventing experience. Never quote the whole resume back to the user and never invent an employer, title, date, or achievement that is not in it.',
          inputSchema: z.object({}),
          async execute() {
            const resume = await readCandidateResume(scope);
            if (!resume) {
              return {
                stored: false as const,
                text: "",
              };
            }
            return {
              filename: resume.filename,
              stored: true as const,
              text: resume.text,
              updatedAt: resume.updatedAt,
            };
          },
        }),
      };
    },
  },
});
