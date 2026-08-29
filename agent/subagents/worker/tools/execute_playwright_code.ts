import { defineTool } from "eve/tools";
import { z } from "zod";
import { executePlaywrightCode } from "@/lib/browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withWorkerToolError } from "@/agent/lib/worker-tool-error";

const inputSchema = z.object({
  code: z.string().min(1),
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Execute Playwright/TypeScript automation code against an existing browser session with a 30-second ceiling. Batch related operations, use "domcontentloaded" or a precise locator with waits of at most five seconds except for one managed CAPTCHA wait of at most 20 seconds, and never wait for "networkidle" or use fixed multi-second sleeps. Does not create or delete browsers. `browser`, `page`, and `context` are in scope.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    return withWorkerToolError(
      "execute_playwright_code",
      input.session_id,
      () =>
        executePlaywrightCode(input.session_id, input.code, context.abortSignal)
    );
  },
});
