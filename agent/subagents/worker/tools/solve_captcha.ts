import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  captchaInspectCode,
  captchaSettleCode,
  captchaSolveResultSchema,
  normalizeCaptchaInspectResult,
  normalizeCaptchaSettleResult,
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
    'Click a visible checkbox CAPTCHA after Kernel reports it cannot auto-solve it (including the live-view message "visible hcaptcha could not be solved automatically"). Uses Kernel computer mouse control. Call immediately when that message or a checkbox hCaptcha appears; do not wait for Kernel\'s managed solver. Does not solve image puzzles, inject tokens, or create browsers.',
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

    if (!inspected.clicked) {
      const state = inspected.kinds.includes("hcaptcha_challenge")
        ? ("challenge_required" as const)
        : ("not_found" as const);
      const result = {
        kernelDeclined: inspected.kernelDeclined,
        kernelMessages: inspected.kernelMessages,
        kinds: inspected.kinds,
        state,
        url: inspected.url,
      };
      await checkpoint(scope, input.session_id, {
        action: "inspect",
        errorCode: inspected.kernelDeclined
          ? "kernel_hcaptcha_unsolved"
          : state,
        page: inspected.url,
        phase: "captcha",
        state,
        trace: inspected.kernelMessages,
      });
      return result;
    }

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

    const settled = normalizeCaptchaSettleResult(
      await kernel.browsers.playwright.execute(
        input.session_id,
        { code: captchaSettleCode, timeout_sec: 30 },
        { signal }
      )
    );
    const state = !settled
      ? ("execution_failed" as const)
      : settled.token
        ? ("solved" as const)
        : settled.challenge
          ? ("challenge_required" as const)
          : ("unsolved" as const);
    const result = {
      clicked: inspected.clicked,
      clickSource: "computer" as const,
      kernelDeclined: inspected.kernelDeclined,
      kernelMessages: inspected.kernelMessages,
      kinds: settled?.kinds ?? inspected.kinds,
      state,
      url: settled?.url ?? inspected.url,
    };
    await checkpoint(scope, input.session_id, {
      action: "computer_click",
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
        `${inspected.clicked.kind}:${String(inspected.clicked.x)},${String(inspected.clicked.y)}`,
        ...inspected.kernelMessages,
      ],
    });
    console.info("[captcha-solver] settle", {
      browser_session_id: input.session_id,
      click: inspected.clicked,
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
