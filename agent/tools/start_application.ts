import { defineTool } from "eve/tools";
import { z } from "zod";
import { startApplication } from "@/lib/application-runner";
import { scopeFromPrincipal } from "@/lib/access-scope";

export default defineTool({
  description:
    "Start filling one job application in the durable Playwright runner. Pass the posting apply_url, role, and company. Returns { status: working } when the run starts, or already_in_progress if that posting is already held. Never call worker. Do not poll; wait for a pause (approval screenshots, OTP, vault, or user input) then continue_application.",
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
