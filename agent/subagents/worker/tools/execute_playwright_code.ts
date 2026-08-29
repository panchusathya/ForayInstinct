import { defineTool } from "eve/tools";
import { z } from "zod";
import { kernel } from "@/lib/kernel";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";

const inputSchema = z.object({
  code: z.string().min(1),
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Execute Playwright/TypeScript automation code against an existing browser session with a 30-second ceiling. Batch related operations, use "domcontentloaded" or a precise locator with waits of at most five seconds except for one managed CAPTCHA wait of at most 20 seconds, and never wait for "networkidle" or use fixed multi-second sleeps. Use solve_captcha instead of clicking a CAPTCHA widget. Does not create or delete browsers.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    try {
      const response = await kernel.browsers.playwright.execute(
        input.session_id,
        { code: input.code, timeout_sec: 30 },
        { signal: context.abortSignal }
      );
      await checkpoint(scope, input.session_id, {
        action: "execute",
        errorCode: response.success ? undefined : "playwright_execution",
        phase: "playwright",
        state: response.success ? "completed" : "failed",
      });
      return response;
    } catch (error) {
      await checkpoint(scope, input.session_id, {
        action: "execute",
        errorCode: diagnosticErrorCode(error),
        phase: "playwright",
        state: "failed",
      });
      throw error;
    }
  },
});

async function checkpoint(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  sessionId: string,
  checkpointInput: Parameters<typeof recordBrowserRunCheckpoint>[2]
) {
  await recordBrowserRunCheckpoint(scope, sessionId, checkpointInput).catch(
    (error: unknown) => {
      console.error("[browser-checkpoint] persistence failed", {
        error_code: diagnosticErrorCode(error),
        phase: checkpointInput.phase,
        session_id: sessionId,
      });
    }
  );
}

function diagnosticErrorCode(error: unknown) {
  if (typeof error !== "string" && !(error instanceof Error)) {
    return "playwright_execution";
  }
  const message = typeof error === "string" ? error : error.message;
  if (/timeout/i.test(message)) return "timeout";
  if (/chrome-error|net::/i.test(message)) return "navigation";
  if (/selector|locator/i.test(message)) return "selector";
  return "playwright_execution";
}
