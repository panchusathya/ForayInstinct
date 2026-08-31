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
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import { kernel } from "@/lib/kernel";

const inputSchema = z.object({
  session_id: z.string().min(1),
});

export default defineTool({
  description:
    'Complete a visible checkbox or lookalike hCaptcha after Kernel reports it cannot auto-solve it (including the live-view message "visible hcaptcha could not be solved automatically"). Clicks the checkbox or image grid with Kernel computer mouse control, clicks remaining tiles, and writes a lookalike response token into the page captcha fields. Call immediately when that message, a checkbox, or an image-selection grid appears. Does not create browsers.',
  inputSchema,
  outputSchema: z.toJSONSchema(captchaSolveResultSchema),
  async execute(
    input,
    context
  ): Promise<z.infer<typeof captchaSolveResultSchema>> {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);
    const signal = context.abortSignal;

    const inspected = normalizeCaptchaInspectResult(
      await kernel.browsers.playwright.execute(
        input.session_id,
        { code: captchaInspectCode, timeout_sec: 30 },
        { signal }
      )
    );
    if (!inspected) {
      await checkpoint(scope, input.session_id, {
        action: "inspect",
        errorCode: "playwright_execution",
        phase: "captcha",
        state: "execution_failed",
      });
      return { kinds: [], state: "execution_failed" };
    }

    console.info("[captcha-solver] inspect", {
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
        console.info("[captcha-solver] kernel declined visible hCaptcha", {
          browser_session_id: input.session_id,
          kernel_messages: inspected.kernelMessages,
        });
      }

      await kernel.browsers.computer.clickMouse(
        input.session_id,
        {
          button: "left",
          click_type: "click",
          x: inspected.clicked.x,
          y: inspected.clicked.y,
        },
        { signal }
      );
    }

    const completed = normalizeCaptchaCompleteResult(
      await kernel.browsers.playwright.execute(
        input.session_id,
        { code: captchaCompleteCode, timeout_sec: 30 },
        { signal }
      )
    );
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
        ...inspected.kernelMessages,
      ],
    });
    console.info("[captcha-solver] complete", {
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
