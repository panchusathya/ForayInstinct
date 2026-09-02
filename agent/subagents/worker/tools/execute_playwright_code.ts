import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { browserProvider } from "@/lib/browser";
import type { PlaywrightResponse } from "@/lib/browser/contract";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordBrowserActionCheckpoint } from "@/agent/subagents/worker/lib/browser-run-evidence";
import {
  boundResultText,
  playwrightErrorMaxChars,
  playwrightResultMaxChars,
} from "@/agent/subagents/worker/lib/bounded-result";
import { listBrowserRunCheckpoints } from "@/db/services/browser-run-checkpoints";
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

const screenshotRecoveryInstruction =
  "Recovery gate: inspect the error and post-action state; call computer_action with a screenshot only if the live controls are still unclear. Use one different Playwright tactic; the failed code cannot be replayed.";

export default defineTool({
  description:
    'Execute Playwright/TypeScript automation code against an existing browser session with a 30-second ceiling after the live controls are identified (screenshot only when visual inspection is needed). Batch related operations, use "domcontentloaded" or a precise locator with waits of at most five seconds except for one managed CAPTCHA wait of at most 20 seconds, and never wait for "networkidle" or use fixed multi-second sleeps. On failure, obey next_action: inspect first, screenshot only if the controls are still unclear, and change tactic; do not replay the same selector or pass a Buffer to setInputFiles. Use solve_captcha for a checkbox or lookalike hCaptcha, including image grids and response-field tokens. Return only the compact data you need (a short object of labels, values, URLs); a result over 4,000 characters is truncated. Does not create or delete browsers.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    const recoveryInstruction = await requiredPlaywrightRecovery(
      scope,
      input.session_id,
      input.code
    );
    if (recoveryInstruction) {
      return {
        error:
          "A prior Playwright failure requires visual recovery before another execution.",
        next_action: recoveryInstruction,
        success: false,
      };
    }
    let response: PlaywrightResponse;
    try {
      response = await browserProvider.executePlaywright(
        input.session_id,
        { code: input.code, timeoutSec: 30 },
        context.abortSignal
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
        trace: response.success
          ? undefined
          : [playwrightCodeFingerprint(input.code)],
      },
      context.abortSignal
    );
    if (executionFailure?.sessionEnded) {
      // The model sees only the error text, and "code failed" reads as worth
      // retrying. Say the session is unrecoverable instead.
      throw browserSessionEndedError(input.session_id);
    }
    // Diagnostics above read the full error; only the model-facing copy is
    // capped, because eve forwards tool results into context uncut.
    return {
      success: response.success,
      ...(response.result === undefined
        ? {}
        : {
            result: boundResultText(response.result, playwrightResultMaxChars),
          }),
      ...(response.error === undefined
        ? {}
        : { error: boundResultText(response.error, playwrightErrorMaxChars) }),
      ...(browserState === undefined ? {} : { browser_state: browserState }),
      ...(nextAction === undefined ? {} : { next_action: nextAction }),
    };
  },
});

/**
 * Tool instructions alone cannot prevent a model from repeatedly submitting
 * the same missing selector. Checkpoints survive worker turns, so use them as
 * the recovery boundary: a failed execution must be followed by a screenshot,
 * and a screenshot never authorizes replaying that failed code.
 */
async function requiredPlaywrightRecovery(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  sessionId: string,
  code: string
) {
  const checkpoints = await listBrowserRunCheckpoints(scope, sessionId).catch(
    () => []
  );
  const latest = checkpoints.at(0);
  const latestPlaywright = checkpoints.find(
    (checkpoint) =>
      checkpoint.action === "execute" && checkpoint.phase === "playwright"
  );
  const screenshotRecovered =
    latest?.action === "batch" &&
    latest.state === "completed" &&
    latest.actions.includes("screenshot");

  if (latestPlaywright?.state === "failed" && !screenshotRecovered) {
    return screenshotRecoveryInstruction;
  }
  if (
    latestPlaywright?.state === "failed" &&
    latestPlaywright.trace.includes(playwrightCodeFingerprint(code))
  ) {
    return "Recovery gate: this exact Playwright code already failed. Use the screenshot observations for one materially different tactic, or report the verified blocker.";
  }
  return undefined;
}

function playwrightCodeFingerprint(code: string) {
  return `playwright-code-sha256:${createHash("sha256")
    .update(code)
    .digest("base64url")}`;
}
