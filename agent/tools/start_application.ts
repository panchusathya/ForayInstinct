import { defineTool } from "eve/tools";
import { z } from "zod";
import { startApplication } from "@/lib/application-runner";
import { scopeFromPrincipal } from "@/lib/access-scope";

export default defineTool({
  description:
    "Start filling one job application in the Playwright runner. Pass the posting apply_url, role, and company. Returns already_in_progress if that posting is already held. Otherwise it fills the form and returns { status: waiting, pause } at the first pause — approval | email_otp | user_input | vault_setup | posting_unavailable — or { status: completed } if the posting needed nothing. A durable run instead returns { status: working } and reports its pause later. Classify by the pause field, never by parsing Needs prefixes. Returns { status: needs_profile, missing } when the stored profile cannot fill the form: nothing was started, no browser opened, and the posting is not held. Ask for exactly those labels once, save them with candidate_profile, then call start_application again — never continue_application. Never call worker. Do not poll; act on the pause you get back, then continue_application.",
  inputSchema: z.object({
    apply_url: z.url(),
    company: z.string().min(1).max(160).default(""),
    role: z.string().min(1).max(160),
  }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) throw new Error("An authenticated user is required.");
    return startApplication({
      applyUrl: input.apply_url,
      company: input.company,
      role: input.role,
      rootSessionId: ctx.session.id,
      scope: scopeFromPrincipal(caller),
    });
  },
});
