import { defineTool } from "eve/tools";
import { z } from "zod";
import { kernel } from "@/lib/kernel";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordBrowserActionCheckpoint } from "@/agent/subagents/worker/lib/browser-run-evidence";
import {
  browserSessionEndedError,
  diagnosticErrorCode,
  forgetDeadBrowserSession,
  handleBrowserToolFailure,
  isDeadBrowserExecutionError,
  logChallengeProbe,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";

const inputSchema = z.object({
  code: z.string().min(1),
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Execute Playwright/TypeScript automation code against an existing browser session with a 30-second ceiling. Batch related operations, use "domcontentloaded" or a precise locator with waits of at most five seconds except for one managed CAPTCHA wait of at most 20 seconds, and never wait for "networkidle" or use fixed multi-second sleeps. Use solve_captcha for a checkbox or lookalike hCaptcha, including image grids and response-field tokens. Does not create or delete browsers.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    let response: Awaited<
      ReturnType<typeof kernel.browsers.playwright.execute>
    >;
    try {
      response = await kernel.browsers.playwright.execute(
        input.session_id,
        { code: input.code, timeout_sec: 30 },
        { signal: context.abortSignal }
      );
    } catch (error) {
      await recordBrowserActionCheckpoint(
        scope,
        input.session_id,
        {
          action: "execute",
          errorCode: diagnosticErrorCode(error),
          phase: "playwright",
          state: "failed",
        },
        context.abortSignal
      );
      throw await handleBrowserToolFailure({
        error,
        scope,
        sessionId: input.session_id,
        signal: context.abortSignal,
        tool: "execute_playwright_code",
        trigger: "playwright_threw",
      });
    }

    // A call that returned rather than threw can still be reporting a browser
    // that is gone. Handled outside the catch above so reconciling it does not
    // also fire the challenge probe against a session that no longer exists.
    const dead =
      !response.success && isDeadBrowserExecutionError(response.error);
    await recordBrowserActionCheckpoint(
      scope,
      input.session_id,
      {
        action: "execute",
        errorCode: response.success
          ? undefined
          : dead
            ? "session_gone"
            : "playwright_execution",
        phase: "playwright",
        state: response.success ? "completed" : "failed",
      },
      context.abortSignal
    );
    if (dead) {
      console.warn("[browser-session] unusable", {
        browser_session_id: input.session_id,
        reason: "execution_reported_dead",
        tool: "execute_playwright_code",
        workspace_id: scope.workspaceId,
      });
      await forgetDeadBrowserSession(scope, input.session_id);
      // The model sees only the error text, and "code failed" reads as worth
      // retrying. Say the session is unrecoverable instead.
      throw browserSessionEndedError(input.session_id);
    }
    if (!response.success) {
      await logChallengeProbe({
        sessionId: input.session_id,
        signal: context.abortSignal,
        trigger: "playwright_execution_failed",
        workspaceId: scope.workspaceId,
      });
    }
    return response;
  },
});
