import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelApplication } from "@/lib/application-runner";
import { scopeFromPrincipal } from "@/lib/access-scope";

export default defineTool({
  description:
    "Cancel the in-flight application for this posting URL, release the lease, and close its browser. Use when the candidate declines or asks to stop.",
  inputSchema: z.object({
    apply_url: z.url(),
  }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) throw new Error("An authenticated user is required.");
    return cancelApplication({
      applyUrl: input.apply_url,
      scope: scopeFromPrincipal(caller),
    });
  },
});
