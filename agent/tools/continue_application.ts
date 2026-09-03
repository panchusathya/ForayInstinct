import { defineTool } from "eve/tools";
import { z } from "zod";
import { continueApplication } from "@/lib/application-runner";
import { scopeFromPrincipal } from "@/lib/access-scope";

export default defineTool({
  description:
    "Resume a paused application run after candidate approval, an OTP, vault setup, or answers to leftover fields. Pass the same apply_url. When the pause carried `questions`, put the candidate's replies in `answered` as an object keyed by each question's exact `label`; the runner fills those controls and remembers the facts without a model. Use `answers` only for free text that no listed question covers. Never pass an answer the candidate did not give. Set approved true only after the candidate explicitly confirms the review screenshots. Never approve on their behalf. Returns { pause } from the same enum as start_application.",
  inputSchema: z.object({
    answered: z.record(z.string().max(300), z.string().max(500)).optional(),
    answers: z.string().max(4_000).optional(),
    apply_url: z.url(),
    approved: z.boolean().optional(),
    otp: z.string().max(32).optional(),
  }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) throw new Error("An authenticated user is required.");
    return continueApplication({
      answered: input.answered,
      answers: input.answers,
      applyUrl: input.apply_url,
      approved: input.approved,
      otp: input.otp,
      scope: scopeFromPrincipal(caller),
    });
  },
});
