import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  captchaSolverCode,
  captchaSolveResultSchema,
  normalizeCaptchaSolveResult,
} from "@/agent/subagents/worker/lib/captcha-solver";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { kernel } from "@/lib/kernel";

const inputSchema = z.object({
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    "Click a visible checkbox CAPTCHA (hCaptcha, including Imperva/Incapsula interstitials, or an uncleared Turnstile checkbox) with a trusted CDP mouse event. Call once after Kernel's managed solver wait. Does not solve image puzzles, inject tokens, or create browsers.",
  inputSchema,
  outputSchema: captchaSolveResultSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    return normalizeCaptchaSolveResult(
      await kernel.browsers.playwright.execute(
        input.session_id,
        { code: captchaSolverCode, timeout_sec: 30 },
        { signal: context.abortSignal }
      )
    );
  },
});
