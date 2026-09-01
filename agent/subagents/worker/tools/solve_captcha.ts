import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  captchaCompleteCode,
  captchaInspectCode,
  captchaSolveResultSchema,
  normalizeCaptchaCompleteResult,
  normalizeCaptchaInspectResult,
} from "@/agent/subagents/worker/lib/captcha-solver";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  browserExecutionFailureDetails,
  diagnoseBrowserExecutionFailure,
  handleBrowserToolFailure,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import { browserProvider, isGatewayProvider } from "@/lib/browser";
import { kernel } from "@/lib/kernel";

const inputSchema = z.object({
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Complete a visible checkbox or lookalike hCaptcha the managed solver could not auto-solve (including the message "visible hcaptcha could not be solved automatically"). Clicks the checkbox or image grid with mouse control, clicks remaining tiles, and writes a lookalike response token into the page captcha fields. Call immediately when that message, a checkbox, or an image-selection grid appears. Does not create browsers.',
  inputSchema,
  outputSchema: z.toJSONSchema(captchaSolveResultSchema),
  async execute(
    input,
    context
  ): Promise<z.infer<typeof captchaSolveResultSchema>> {
    const scope = await requireWorkerScope(context);
    // Logged before the ownership check, and before any page work, so that an
    // invocation is recorded even when the session is already gone. "The solver
    // was never called" and "the solver was called too late" are different
    // bugs, and every other line in this tool is downstream of a live session.
    console.warn("[captcha-solver] invoked", {
      browser_session_id: input.session_id,
      workspace_id: scope.workspaceId,
    });
    try {
      await requireOwnedBrowserSession(scope, input.session_id);
    } catch (error: unknown) {
      throw await handleBrowserToolFailure({
        error,
        scope,
        sessionId: input.session_id,
        signal: context.abortSignal,
        tool: "solve_captcha",
        trigger: "solve_captcha_ownership",
      });
    }
    const signal = context.abortSignal;

    // Brightdata ships its own solver behind a custom CDP command; give it
    // one bounded chance before the manual lookalike path.
    if (isGatewayProvider(browserProvider)) {
      const solvedByGateway = await waitForGatewaySolve(
        input.session_id,
        signal
      );
      if (solvedByGateway) {
        await checkpoint(scope, input.session_id, {
          action: "managed_solve",
          phase: "captcha",
          state: "already_solved",
        });
        return {
          kinds: [],
          state: "already_solved" as const,
        };
      }
    }

    const inspectResponse = await executeCaptchaPlaywright(
      input.session_id,
      captchaInspectCode,
      "inspect",
      scope,
      signal
    );
    if (inspectResponse && !inspectResponse.success) {
      await diagnoseBrowserExecutionFailure({
        error: inspectResponse.error,
        scope,
        sessionId: input.session_id,
        signal,
        tool: "solve_captcha",
        trigger: "solve_captcha_inspect_failed",
      });
    }
    const inspected = inspectResponse
      ? normalizeCaptchaInspectResult(inspectResponse)
      : undefined;
    if (!inspected) {
      await checkpoint(scope, input.session_id, {
        action: "inspect",
        errorCode: browserExecutionFailureDetails(inspectResponse?.error)
          .errorCode,
        phase: "captcha",
        state: "execution_failed",
      });
      return { kinds: [], state: "execution_failed" };
    }

    console.warn("[captcha-solver] inspect", {
      browser_session_id: input.session_id,
      kernel_declined: inspected.kernelDeclined,
      kernel_messages: inspected.kernelMessages,
      kinds: inspected.kinds,
      token: inspected.token,
    });

    if (inspected.token) {
      const result = {
        kernelDeclined: inspected.kernelDeclined,
        kernelMessages: inspected.kernelMessages,
        kinds: inspected.kinds,
        state: "already_solved" as const,
        url: inspected.url,
      };
      await checkpoint(scope, input.session_id, {
        action: "inspect",
        page: inspected.url,
        phase: "captcha",
        state: result.state,
        trace: inspected.kernelMessages,
      });
      return result;
    }

    if (inspected.clicked) {
      if (inspected.kernelDeclined) {
        console.warn("[captcha-solver] kernel declined visible hCaptcha", {
          browser_session_id: input.session_id,
          kernel_messages: inspected.kernelMessages,
        });
      }

      await clickAt(input.session_id, inspected.clicked, signal);
    }

    const completeResponse = await executeCaptchaPlaywright(
      input.session_id,
      captchaCompleteCode,
      "complete",
      scope,
      signal
    );
    if (completeResponse && !completeResponse.success) {
      await diagnoseBrowserExecutionFailure({
        error: completeResponse.error,
        scope,
        sessionId: input.session_id,
        signal,
        tool: "solve_captcha",
        trigger: "solve_captcha_complete_failed",
      });
    }
    const completed = completeResponse
      ? normalizeCaptchaCompleteResult(completeResponse)
      : undefined;
    const state = !completed
      ? ("execution_failed" as const)
      : completed.token
        ? ("solved" as const)
        : completed.challenge
          ? ("challenge_required" as const)
          : inspected.clicked
            ? ("unsolved" as const)
            : ("not_found" as const);
    const result = {
      clicked: inspected.clicked,
      clickSource: inspected.clicked
        ? ("computer" as const)
        : ("none" as const),
      injected: completed?.injected,
      kernelDeclined: inspected.kernelDeclined,
      kernelMessages: inspected.kernelMessages,
      kinds: completed?.kinds ?? inspected.kinds,
      state,
      url: completed?.url ?? inspected.url,
    };
    await checkpoint(scope, input.session_id, {
      action: inspected.clicked ? "computer_click" : "complete",
      errorCode:
        state === "solved"
          ? undefined
          : inspected.kernelDeclined
            ? "kernel_hcaptcha_unsolved"
            : state,
      page: result.url,
      phase: "captcha",
      state,
      trace: [
        inspected.clicked
          ? `${inspected.clicked.kind}:${String(inspected.clicked.x)},${String(inspected.clicked.y)}`
          : "no_click",
        completed?.injected ? "injected_lookalike_token" : "no_inject",
        `tiles:${String(completed?.tilesClicked ?? 0)}`,
        ...inspected.kernelMessages,
      ],
    });
    console.warn("[captcha-solver] complete", {
      browser_session_id: input.session_id,
      click: inspected.clicked,
      injected: completed?.injected,
      state,
    });
    return result;
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
        error:
          error instanceof Error ? error.message : "captcha_checkpoint_failed",
        phase: checkpointInput.phase,
        session_id: sessionId,
      });
    }
  );
}

async function clickAt(
  sessionId: string,
  point: { x: number; y: number },
  signal?: AbortSignal
) {
  if (isGatewayProvider(browserProvider)) {
    await browserProvider.runAction(
      sessionId,
      {
        click_mouse: {
          button: "left",
          click_type: "click",
          x: point.x,
          y: point.y,
        },
        type: "click_mouse",
      },
      signal
    );
    return;
  }
  await kernel.browsers.computer.clickMouse(
    sessionId,
    {
      button: "left",
      click_type: "click",
      x: point.x,
      y: point.y,
    },
    { signal }
  );
}

/**
 * Asks Brightdata's built-in solver whether it detected and solved a captcha.
 * The command is a Brightdata CDP extension; an unknown-command error means
 * the manual path proceeds as usual.
 */
async function waitForGatewaySolve(sessionId: string, signal?: AbortSignal) {
  try {
    return await browserProvider.withCdpPage(
      sessionId,
      async ({ send }) => {
        const outcome = await send("Captcha.waitForSolve", {
          detectTimeout: 10_000,
        });
        return (
          typeof outcome === "object" &&
          outcome !== null &&
          "status" in outcome &&
          outcome.status === "solve_finished"
        );
      },
      signal
    );
  } catch {
    return false;
  }
}

async function executeCaptchaPlaywright(
  sessionId: string,
  code: string,
  phase: "inspect" | "complete",
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  signal?: AbortSignal
) {
  try {
    return await browserProvider.executePlaywright(
      sessionId,
      { code, timeoutSec: 30 },
      signal
    );
  } catch (error: unknown) {
    const surfaced = await handleBrowserToolFailure({
      error,
      scope,
      sessionId,
      signal,
      tool: "solve_captcha",
      trigger: `solve_captcha_${phase}_threw`,
    });
    console.warn(`[captcha-solver] ${phase} failed`, {
      browser_session_id: sessionId,
      ...browserExecutionFailureDetails(surfaced),
      workspace_id: scope.workspaceId,
    });
    return undefined;
  }
}
