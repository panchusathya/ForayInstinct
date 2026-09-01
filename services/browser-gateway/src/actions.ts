import type { Page } from "playwright-core";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import type {
  GatewayAction,
  actionsResponseSchema,
} from "../../../lib/browser/contract.ts";
import type { z } from "zod";
import { withScreenshotMask } from "./screenshot.ts";

/**
 * Kernel's computer-action key names -> Playwright keyboard key names.
 * Lookup is case-insensitive; unknown multi-character names and single
 * characters pass through unchanged so `a`, `A`, or `-` keep working.
 */
const kernelKeymap: Record<string, string> = {
  alt: "Alt",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  backspace: "Backspace",
  capslock: "CapsLock",
  cmd: "Meta",
  command: "Meta",
  control: "Control",
  ctrl: "Control",
  del: "Delete",
  delete: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  left: "ArrowLeft",
  menu: "ContextMenu",
  meta: "Meta",
  numlock: "NumLock",
  pagedown: "PageDown",
  pageup: "PageUp",
  pause: "Pause",
  printscreen: "PrintScreen",
  return: "Enter",
  right: "ArrowRight",
  scrolllock: "ScrollLock",
  shift: "Shift",
  space: " ",
  super: "Meta",
  tab: "Tab",
  up: "ArrowUp",
  win: "Meta",
};

export function mapKernelKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  const mapped = kernelKeymap[normalized];
  if (mapped) return mapped;
  if (/^f\d{1,2}$/u.test(normalized)) return normalized.toUpperCase();
  return key;
}

async function withHeldKeys(
  page: Page,
  holdKeys: string[] | undefined,
  run: () => Promise<void>
): Promise<void> {
  const keys = (holdKeys ?? []).map(mapKernelKey);
  for (const key of keys) await page.keyboard.down(key);
  try {
    await run();
  } finally {
    for (const key of keys.toReversed()) await page.keyboard.up(key);
  }
}

type ActionsResponse = z.infer<typeof actionsResponseSchema>;

export async function performActions(
  page: Page,
  actions: GatewayAction[]
): Promise<ActionsResponse> {
  const screenshots: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "click_mouse": {
        const payload = action.click_mouse;
        if (!payload) break;
        const button = payload.button ?? "left";
        await withHeldKeys(page, payload.hold_keys, async () => {
          await page.mouse.move(payload.x, payload.y);
          if (payload.click_type === "down") {
            await page.mouse.down({ button });
          } else if (payload.click_type === "up") {
            await page.mouse.up({ button });
          } else {
            await page.mouse.click(payload.x, payload.y, {
              button,
              clickCount: payload.num_clicks ?? 1,
            });
          }
        });
        break;
      }
      case "move_mouse": {
        const payload = action.move_mouse;
        if (!payload) break;
        await withHeldKeys(page, payload.hold_keys, () =>
          page.mouse.move(payload.x, payload.y)
        );
        break;
      }
      case "type_text": {
        const payload = action.type_text;
        if (!payload) break;
        await page.keyboard.type(payload.text, { delay: payload.delay });
        break;
      }
      case "press_key": {
        const payload = action.press_key;
        if (!payload) break;
        await withHeldKeys(page, payload.hold_keys, async () => {
          const keys = payload.keys.map(mapKernelKey);
          for (const key of keys) await page.keyboard.down(key);
          try {
            if (payload.duration) await page.waitForTimeout(payload.duration);
          } finally {
            for (const key of keys.toReversed()) await page.keyboard.up(key);
          }
        });
        break;
      }
      case "scroll": {
        const payload = action.scroll;
        if (!payload) break;
        await withHeldKeys(page, payload.hold_keys, async () => {
          await page.mouse.move(payload.x, payload.y);
          await page.mouse.wheel(payload.delta_x ?? 0, payload.delta_y ?? 0);
        });
        break;
      }
      case "drag_mouse": {
        const payload = action.drag_mouse;
        if (!payload || payload.path.length < 2) break;
        const button = payload.button ?? "left";
        await withHeldKeys(page, payload.hold_keys, async () => {
          // The schema pins every path point to exactly two numbers.
          const [startX = 0, startY = 0] = payload.path[0];
          await page.mouse.move(startX, startY);
          await page.mouse.down({ button });
          try {
            if (payload.delay) await page.waitForTimeout(payload.delay);
            for (const point of payload.path.slice(1)) {
              const [x = 0, y = 0] = point;
              await page.mouse.move(x, y, {
                steps: payload.steps_per_segment ?? 1,
              });
              if (payload.step_delay_ms) {
                await page.waitForTimeout(payload.step_delay_ms);
              }
            }
          } finally {
            await page.mouse.up({ button });
          }
        });
        break;
      }
      case "sleep": {
        const payload = action.sleep;
        if (!payload) break;
        await page.waitForTimeout(Math.min(payload.duration_ms, 2_000));
        break;
      }
      case "screenshot": {
        const payload = action.screenshot;
        const png = await withScreenshotMask(
          page,
          payload?.mask_css,
          payload?.mask_style_id,
          () => page.screenshot({ clip: payload?.region })
        );
        screenshots.push(png.toString("base64"));
        break;
      }
    }
  }
  return screenshots.length > 0 ? { screenshots_base64: screenshots } : {};
}
