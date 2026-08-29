import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import type { Page } from "playwright-core";
import { withRemotePage } from "@/lib/browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withWorkerToolError } from "@/agent/lib/worker-tool-error";

const actionSchema = z.object({
  type: z.enum([
    "click_mouse",
    "move_mouse",
    "type_text",
    "press_key",
    "scroll",
    "drag_mouse",
    "set_cursor",
    "sleep",
    "write_clipboard",
    "read_clipboard",
    "screenshot",
    "get_mouse_position",
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
  set_cursor: z.object({ hidden: z.boolean() }).optional(),
  sleep: z
    .object({ duration_ms: z.number().int().min(0).max(2_000) })
    .optional(),
  write_clipboard: z.object({ text: z.string() }).optional(),
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

const inputSchema = z.object({
  session_id: z.string().min(1),
  actions: z.array(actionSchema).min(1),
});

const outputSchema = z.object({
  data: z.unknown().optional(),
  message: z.string(),
  mimeType: z.literal("image/png").optional(),
  screenshotBase64: z.string().optional(),
});

export default defineTool({
  description:
    "Execute a bounded batch of computer actions on one browser session. Prefer one batch over repeated calls, keep sleep actions at or below two seconds, and include a screenshot last only when visual inspection is needed; screenshots are delivered directly to the vision model.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);

    return withWorkerToolError("computer_action", input.session_id, () =>
      withRemotePage(
        input.session_id,
        context.abortSignal,
        async ({ page }) => {
          const data: unknown[] = [];
          let screenshotBase64: string | undefined;
          let mouse = { x: 0, y: 0 };

          for (const action of input.actions) {
            switch (action.type) {
              case "click_mouse": {
                const payload = requiredAction(action.click_mouse, action.type);
                await withHeldKeys(page, payload.hold_keys, async () => {
                  await page.mouse.move(payload.x, payload.y);
                  mouse = { x: payload.x, y: payload.y };
                  const button = payload.button ?? "left";
                  if (payload.click_type === "down") {
                    await page.mouse.down({ button });
                    return;
                  }
                  if (payload.click_type === "up") {
                    await page.mouse.up({ button });
                    return;
                  }
                  await page.mouse.click(payload.x, payload.y, {
                    button,
                    clickCount: payload.num_clicks ?? 1,
                  });
                });
                break;
              }
              case "move_mouse": {
                const payload = requiredAction(action.move_mouse, action.type);
                await withHeldKeys(page, payload.hold_keys, async () => {
                  await page.mouse.move(payload.x, payload.y);
                  mouse = { x: payload.x, y: payload.y };
                });
                break;
              }
              case "type_text": {
                const payload = requiredAction(action.type_text, action.type);
                await page.keyboard.type(payload.text, {
                  delay: payload.delay,
                });
                break;
              }
              case "press_key": {
                const payload = requiredAction(action.press_key, action.type);
                await withHeldKeys(page, payload.hold_keys, async () => {
                  for (const key of payload.keys) {
                    await page.keyboard.press(key, {
                      delay: payload.duration,
                    });
                  }
                });
                break;
              }
              case "scroll": {
                const payload = requiredAction(action.scroll, action.type);
                await withHeldKeys(page, payload.hold_keys, async () => {
                  await page.mouse.move(payload.x, payload.y);
                  await page.mouse.wheel(
                    payload.delta_x ?? 0,
                    payload.delta_y ?? 0
                  );
                  mouse = { x: payload.x, y: payload.y };
                });
                break;
              }
              case "drag_mouse": {
                const payload = requiredAction(action.drag_mouse, action.type);
                const startPoint = dragPoint(payload.path[0]);
                const rest = payload.path.slice(1);
                await withHeldKeys(page, payload.hold_keys, async () => {
                  await page.mouse.move(startPoint.x, startPoint.y);
                  await page.mouse.down({
                    button: payload.button ?? "left",
                  });
                  for (const point of rest) {
                    const next = dragPoint(point);
                    await page.mouse.move(next.x, next.y, {
                      steps: payload.steps_per_segment,
                    });
                    if (payload.step_delay_ms) {
                      await page.waitForTimeout(payload.step_delay_ms);
                    }
                  }
                  await page.mouse.up({ button: payload.button ?? "left" });
                  const last = dragPoint(
                    payload.path.at(-1) ?? payload.path[0]
                  );
                  mouse = { x: last.x, y: last.y };
                });
                break;
              }
              case "set_cursor": {
                const payload = requiredAction(action.set_cursor, action.type);
                await page.evaluate((hidden) => {
                  document.documentElement.style.cursor = hidden ? "none" : "";
                }, payload.hidden);
                data.push({ hidden: payload.hidden });
                break;
              }
              case "sleep": {
                const payload = requiredAction(action.sleep, action.type);
                await page.waitForTimeout(payload.duration_ms);
                break;
              }
              case "write_clipboard": {
                const payload = requiredAction(
                  action.write_clipboard,
                  action.type
                );
                await page.evaluate(async (text) => {
                  await navigator.clipboard.writeText(text);
                }, payload.text);
                break;
              }
              case "read_clipboard": {
                data.push(
                  await page.evaluate(async () =>
                    navigator.clipboard.readText()
                  )
                );
                break;
              }
              case "get_mouse_position":
                data.push(mouse);
                break;
              case "screenshot": {
                const removeMask = await maskVaultFields(page);
                try {
                  const region = action.screenshot?.region;
                  const buffer = await page.screenshot({
                    clip: region,
                    type: "png",
                  });
                  screenshotBase64 = buffer.toString("base64");
                } finally {
                  await removeMask();
                }
                break;
              }
            }
          }

          return outputSchema.parse({
            data: data.length > 0 ? data : undefined,
            message: `Executed ${String(input.actions.length)} computer action${input.actions.length === 1 ? "" : "s"}.`,
            mimeType: screenshotBase64 ? "image/png" : undefined,
            screenshotBase64,
          });
        }
      )
    );
  },
  toModelOutput(output) {
    if (!output.screenshotBase64) {
      return toolOutput.json({
        data: output.data,
        message: output.message,
      });
    }
    return toolOutput.content([
      toolOutputPart.text(output.message),
      toolOutputPart.file(output.screenshotBase64, {
        mediaType: output.mimeType ?? "image/png",
      }),
    ]);
  },
});

function requiredAction<T>(value: T | undefined, action: string): T {
  if (value === undefined) {
    throw new Error(`Computer action ${action} is missing its payload.`);
  }
  return value;
}

function dragPoint(value: readonly number[] | undefined) {
  const x = value?.[0];
  const y = value?.[1];
  if (x === undefined || y === undefined) {
    throw new Error("A drag path point is missing.");
  }
  return { x, y };
}

async function withHeldKeys(
  page: Page,
  keys: readonly string[] | undefined,
  operate: () => Promise<void>
) {
  for (const key of keys ?? []) await page.keyboard.down(key);
  try {
    await operate();
  } finally {
    for (const key of (keys ?? []).toReversed()) {
      await page.keyboard.up(key);
    }
  }
}

async function maskVaultFields(page: Page) {
  const styleId = "vault-screenshot-mask";
  const selector = '[data-vault-secret="true"]';
  await page.evaluate(
    ({ selector: maskSelector, styleId: id }) => {
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `${maskSelector} { color: transparent !important; text-shadow: 0 0 8px black !important; -webkit-text-security: disc !important; }`;
      document.documentElement.append(style);
    },
    { selector, styleId }
  );
  return async () => {
    await page
      .evaluate((id) => document.getElementById(id)?.remove(), styleId)
      .catch(() => undefined);
  };
}
