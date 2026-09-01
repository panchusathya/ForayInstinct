import { defineTool } from "eve/tools";
import { z } from "zod";
import { kernel } from "@/lib/kernel";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordBrowserActionCheckpoint } from "@/agent/subagents/worker/lib/browser-run-evidence";
import {
  browserSessionEndedError,
  diagnosticErrorCode,
  diagnoseBrowserExecutionFailure,
  handleBrowserToolFailure,
  playwrightFailureNextAction,
  shouldInspectPostActionBrowserState,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";
import {
  inspectPostActionBrowserState,
  postActionBrowserStateInstruction,
} from "@/agent/subagents/worker/lib/post-action-browser-state";

const inputSchema = z.object({
  code: z.string().min(1),
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Execute Playwright/TypeScript automation code against an existing browser session with a 30-second ceiling after a masked computer_action screenshot has identified the live controls. Batch related operations, use "domcontentloaded" or a precise locator with waits of at most five seconds except for one managed CAPTCHA wait of at most 20 seconds, and never wait for "networkidle" or use fixed multi-second sleeps. On failure, obey next_action: screenshot once and change tactic; do not replay the same selector or pass a Buffer to setInputFiles. Use solve_captcha for a checkbox or lookalike hCaptcha, including image grids and response-field tokens. Does not create or delete browsers.',
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

    const executionFailure = response.success
      ? undefined
      : await diagnoseBrowserExecutionFailure({
          error: response.error,
          scope,
          sessionId: input.session_id,
          signal: context.abortSignal,
          tool: "execute_playwright_code",
          trigger: "playwright_execution_failed",
        });
    const skipPostActionInspect =
      executionFailure?.sessionEnded === true ||
      (executionFailure !== undefined &&
        !shouldInspectPostActionBrowserState(executionFailure.errorCode));
    const browserState = skipPostActionInspect
      ? undefined
      : await inspectPostActionBrowserState(
          input.session_id,
          context.abortSignal
        );
    const blockerInstruction = postActionBrowserStateInstruction(browserState);
    const failureInstruction =
      response.success || executionFailure?.sessionEnded
        ? undefined
        : playwrightFailureNextAction(response.error);
    const nextAction = blockerInstruction ?? failureInstruction;
    await recordBrowserActionCheckpoint(
      scope,
      input.session_id,
      {
        action: "execute",
        errorCode: response.success
          ? undefined
          : executionFailure?.sessionEnded
            ? "session_gone"
            : executionFailure?.errorCode,
        phase: "playwright",
        actions: nextAction ? [nextAction] : undefined,
        state: response.success ? "completed" : "failed",
      },
      context.abortSignal
    );
    if (executionFailure?.sessionEnded) {
      // The model sees only the error text, and "code failed" reads as worth
      // retrying. Say the session is unrecoverable instead.
      throw browserSessionEndedError(input.session_id);
    }
    return {
      ...response,
      ...(browserState === undefined ? {} : { browser_state: browserState }),
      ...(nextAction === undefined ? {} : { next_action: nextAction }),
    };
  },
});
