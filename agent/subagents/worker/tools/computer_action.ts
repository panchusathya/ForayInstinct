import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { browserProvider, isGatewayProvider } from "@/lib/browser";
import type { GatewayAction } from "@/lib/browser/contract";
import { kernel } from "@/lib/kernel";
import {
  vaultScreenshotMaskCss,
  vaultScreenshotMaskStyleId,
} from "@/lib/vault-screenshot-mask";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { recordBrowserActionCheckpoint } from "@/agent/subagents/worker/lib/browser-run-evidence";
import { maskVaultFields } from "@/agent/subagents/worker/lib/kernel-screenshot";
import {
  diagnosticErrorCode,
  handleBrowserToolFailure,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";
import { compressScreenshotToJpeg } from "@/lib/vision-screenshot";
import {
  inspectPostActionBrowserState,
  postActionBrowserStateInstruction,
} from "@/agent/subagents/worker/lib/post-action-browser-state";

const actionSchema = z.object({
  type: z.enum([
    "click_mouse",
    "move_mouse",
    "type_text",
    "press_key",
    "scroll",
    "drag_mouse",
    "sleep",
    "screenshot",
  ]),
  click_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      num_clicks: z.number().int().min(1).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  move_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  type_text: z
    .object({
      text: z.string(),
      delay: z.number().int().min(0).max(250).optional(),
    })
    .optional(),
  press_key: z
    .object({
      keys: z.array(z.string()),
      duration: z.number().int().min(0).max(2_000).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  scroll: z
    .object({
      x: z.number(),
      y: z.number(),
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  drag_mouse: z
    .object({
      path: z.array(z.array(z.number()).length(2)).min(2),
      button: z.enum(["left", "middle", "right"]).optional(),
      delay: z.number().int().min(0).max(2_000).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
      step_delay_ms: z.number().int().min(0).max(250).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  sleep: z
    .object({ duration_ms: z.number().int().min(0).max(2_000) })
    .optional(),
  screenshot: z
    .object({
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
    })
    .optional(),
});

// Every screenshot reaches the vision model, and eve never trims a tool
// result, so the batch itself bounds how much one call adds to context.
const maxActionsPerBatch = 12;
const maxScreenshotsPerBatch = 1;

const inputSchema = z
  .object({
    session_id: z.string().min(1),
    actions: z.array(actionSchema).min(1).max(maxActionsPerBatch),
  })
  .refine(
    (value) =>
      value.actions.filter((action) => action.type === "screenshot").length <=
      maxScreenshotsPerBatch,
    {
      message: `At most ${String(maxScreenshotsPerBatch)} screenshot action per batch; send a screenshot only when visual inspection is needed.`,
      path: ["actions"],
    }
  );

const outputSchema = z.object({
  browserState: z.unknown().optional(),
  data: z.unknown().optional(),
  message: z.string(),
  mimeType: z.literal("image/jpeg").optional(),
  screenshotsBase64: z.array(z.string()).optional(),
});

export default defineTool({
  description:
    "Execute a bounded batch of at most 12 computer actions on one browser session. Prefer one batch over repeated calls, keep sleep actions at or below two seconds, and include a screenshot last only when visual inspection is genuinely needed (coordinate targeting, a captcha grid, or an ambiguous overlay), at most one per batch. Prefer Playwright or the returned post-action browser state after create, navigation, and fill. Screenshots are JPEG-compressed and delivered directly to the vision model.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);

    let browserState: Awaited<ReturnType<typeof inspectPostActionBrowserState>>;
    let blockerInstruction: string | undefined;
    const screenshotsBase64: string[] = [];

    try {
      for (const action of input.actions) {
        const captured = await runOneAction(
          input.session_id,
          action,
          context.abortSignal
        );
        screenshotsBase64.push(...captured);
        // A batch can put exploratory recovery actions after a submit. Stop
        // before they can refill or submit again if that click opened an OTP
        // or a bot challenge.
        if (action.type !== "screenshot") {
          browserState = await inspectPostActionBrowserState(
            input.session_id,
            context.abortSignal
          );
          blockerInstruction = postActionBrowserStateInstruction(browserState);
          if (blockerInstruction) break;
        }
      }

      browserState ??= await inspectPostActionBrowserState(
        input.session_id,
        context.abortSignal
      );
      blockerInstruction ??= postActionBrowserStateInstruction(browserState);
      await recordBrowserActionCheckpoint(
        scope,
        input.session_id,
        {
          action: "batch",
          actions: [
            ...input.actions.map((action) => action.type),
            ...(blockerInstruction ? [blockerInstruction] : []),
          ],
          phase: "computer",
          state: "completed",
        },
        context.abortSignal
      );
      const screenshots = screenshotsBase64.map(compressScreenshotToJpeg);
      return outputSchema.parse({
        message:
          blockerInstruction ??
          `Executed ${String(input.actions.length)} computer action${input.actions.length === 1 ? "" : "s"}.`,
        browserState,
        mimeType: screenshots.length > 0 ? "image/jpeg" : undefined,
        screenshotsBase64: screenshots.length > 0 ? screenshots : undefined,
      });
    } catch (error) {
      await recordBrowserActionCheckpoint(
        scope,
        input.session_id,
        {
          action: "batch",
          actions: input.actions.map((action) => action.type),
          errorCode: diagnosticErrorCode(error),
          phase: "computer",
          state: "failed",
        },
        context.abortSignal
      );
      throw await handleBrowserToolFailure({
        error,
        scope,
        sessionId: input.session_id,
        signal: context.abortSignal,
        tool: "computer_action",
        trigger: "computer_action_failed",
      });
    }
  },
  toModelOutput(output) {
    if (!output.screenshotsBase64 || output.screenshotsBase64.length === 0) {
      return toolOutput.json({
        data: output.data,
        message: output.message,
      });
    }
    const latest = output.screenshotsBase64.at(-1);
    if (!latest) {
      return toolOutput.json({
        data: output.data,
        message: output.message,
      });
    }
    return toolOutput.content([
      toolOutputPart.text(
        output.data === undefined
          ? output.message
          : `${output.message}\n${JSON.stringify(output.data)}`
      ),
      toolOutputPart.file(latest, {
        mediaType: output.mimeType ?? "image/jpeg",
      }),
    ]);
  },
});

/** Runs a single action; returns any screenshots it captured. */
async function runOneAction(
  sessionId: string,
  action: z.infer<typeof actionSchema>,
  signal: AbortSignal
): Promise<string[]> {
  if (isGatewayProvider(browserProvider)) {
    const gatewayAction: GatewayAction =
      action.type === "screenshot"
        ? {
            ...action,
            // The gateway applies the vault mask around its own capture; the
            // mask has to ride along because the gateway knows nothing about
            // vault fields.
            screenshot: {
              ...action.screenshot,
              mask_css: vaultScreenshotMaskCss,
              mask_style_id: vaultScreenshotMaskStyleId,
            },
          }
        : action;
    const result = await browserProvider.runAction(
      sessionId,
      gatewayAction,
      signal
    );
    return result.screenshotsBase64 ?? [];
  }
  return runKernelAction(sessionId, action, signal);
}

async function runKernelAction(
  sessionId: string,
  action: z.infer<typeof actionSchema>,
  signal: AbortSignal
): Promise<string[]> {
  const computer = kernel.browsers.computer;
  switch (action.type) {
    case "click_mouse":
      await computer.clickMouse(
        sessionId,
        requiredAction(action.click_mouse, action.type),
        { signal }
      );
      return [];
    case "move_mouse":
      await computer.moveMouse(
        sessionId,
        requiredAction(action.move_mouse, action.type),
        { signal }
      );
      return [];
    case "type_text":
      await computer.typeText(
        sessionId,
        requiredAction(action.type_text, action.type),
        { signal }
      );
      return [];
    case "press_key":
      await computer.pressKey(
        sessionId,
        requiredAction(action.press_key, action.type),
        { signal }
      );
      return [];
    case "scroll":
      await computer.scroll(
        sessionId,
        requiredAction(action.scroll, action.type),
        { signal }
      );
      return [];
    case "drag_mouse":
      await computer.dragMouse(
        sessionId,
        requiredAction(action.drag_mouse, action.type),
        { signal }
      );
      return [];
    case "sleep":
      await computer.batch(
        sessionId,
        {
          actions: [
            {
              sleep: requiredAction(action.sleep, action.type),
              type: "sleep",
            },
          ],
        },
        { signal }
      );
      return [];
    case "screenshot": {
      const removeMask = await maskVaultFields(sessionId, signal);
      try {
        const response = await computer.captureScreenshot(
          sessionId,
          action.screenshot,
          { signal }
        );
        return [Buffer.from(await response.arrayBuffer()).toString("base64")];
      } finally {
        await removeMask();
      }
    }
  }
}

function requiredAction<T>(value: T | undefined, action: string): T {
  if (value === undefined) {
    throw new Error(`Computer action ${action} is missing its payload.`);
  }
  return value;
}
