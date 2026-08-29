import type { PlaywrightExecuteResponse } from "@onkernel/sdk/resources/browsers";
import { z } from "zod";

const captchaKindSchema = z.enum([
  "hcaptcha",
  "hcaptcha_challenge",
  "incapsula",
  "turnstile",
]);

const clickSchema = z.object({
  kind: z.enum(["hcaptcha", "incapsula", "turnstile"]),
  x: z.number(),
  y: z.number(),
});

export const captchaInspectResultSchema = z.object({
  clicked: clickSchema.optional(),
  kernelDeclined: z.boolean(),
  kernelMessages: z.array(z.string()),
  kinds: z.array(captchaKindSchema),
  token: z.boolean(),
  url: z.string().optional(),
});

export const captchaSettleResultSchema = z.object({
  challenge: z.boolean(),
  kinds: z.array(captchaKindSchema),
  token: z.boolean(),
  url: z.string().optional(),
});

export const captchaSolveResultSchema = z.object({
  clicked: clickSchema.optional(),
  clickSource: z.enum(["computer", "none"]).optional(),
  kernelDeclined: z.boolean().optional(),
  kernelMessages: z.array(z.string()).optional(),
  kinds: z.array(captchaKindSchema),
  state: z.enum([
    "already_solved",
    "challenge_required",
    "execution_failed",
    "not_found",
    "solved",
    "unsolved",
  ]),
  url: z.string().optional(),
});

const captchaHelpers = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kernelMessages = [];
page.on("console", (msg) => {
  const text = String(msg.text() || "");
  if (/hcaptcha|captcha|could not be solved/i.test(text)) {
    kernelMessages.push(text.slice(0, 300));
  }
});

const classify = (value) => {
  const haystack = String(value || "").toLowerCase();
  if (/frame=challenge|hcaptcha-challenge|main content of the hcaptcha challenge/.test(haystack)) {
    return "hcaptcha_challenge";
  }
  if (/hcaptcha\\.com|newassets\\.hcaptcha|hcaptcha-widget|h-captcha|widget containing checkbox for hcaptcha/.test(haystack)) {
    return "hcaptcha";
  }
  if (/_incapsula_resource/.test(haystack)) return "incapsula";
  if (/challenges\\.cloudflare|cf-turnstile|turnstile/.test(haystack)) return "turnstile";
  return null;
};

const clickPoint = (box, kind) => {
  if (kind === "hcaptcha") {
    return {
      x: Math.round(box.x + Math.min(30, Math.max(8, box.width * 0.12))),
      y: Math.round(box.y + Math.min(36, Math.max(8, box.height * 0.48))),
    };
  }
  if (kind === "turnstile") {
    return {
      x: Math.round(box.x + Math.min(28, Math.max(8, box.width * 0.18))),
      y: Math.round(box.y + Math.min(32, Math.max(8, box.height * 0.5))),
    };
  }
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + Math.min(120, box.height * 0.42)),
  };
};

const collectWidgets = async (root) => {
  const widgets = [];
  const locators = root.locator("iframe");
  const count = await locators.count();
  for (let index = 0; index < count; index += 1) {
    const iframe = locators.nth(index);
    const src = (await iframe.getAttribute("src")) ?? "";
    const title = (await iframe.getAttribute("title")) ?? "";
    const name = (await iframe.getAttribute("name")) ?? "";
    const widgetId = (await iframe.getAttribute("data-hcaptcha-widget-id")) ?? "";
    const kind = classify([src, title, name, widgetId].join(" "));
    const box = await iframe.boundingBox().catch(() => null);
    if (kind && box && box.width > 0 && box.height > 0) {
      widgets.push({ box, kind });
    }
    const child = await iframe.contentFrame().catch(() => null);
    if (child) widgets.push(...await collectWidgets(child));
  }
  return widgets;
};

const checkboxBox = async () => {
  for (const frame of page.frames()) {
    if (!/hcaptcha|turnstile|incapsula/i.test(frame.url())) continue;
    const checkbox = frame.locator('#checkbox, [role="checkbox"], #cf-stage, .ctp-checkbox-label');
    if (await checkbox.count().catch(() => 0) === 0) continue;
    const box = await checkbox.first().boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      const kind = classify(frame.url()) ?? "hcaptcha";
      if (kind === "hcaptcha_challenge") continue;
      return { box, kind: kind === "incapsula" ? "hcaptcha" : kind };
    }
  }
  return null;
};

const tokenPresent = async () => page.evaluate(() => {
  const nodes = document.querySelectorAll(
    'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"], input[name="cf-turnstile-response"], input[name="cf-challenge-response"]'
  );
  return [...nodes].some((node) => "value" in node && String(node.value || "").trim().length > 20);
}).catch(() => false);

const frameText = async () => {
  const chunks = [];
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (text) chunks.push(text);
  }
  return chunks.join("\\n");
};

const kernelDeclinedFrom = (value) =>
  /visible hcaptcha could not be solved automatically/i.test(String(value || ""));

const detect = async () => {
  const widgets = await collectWidgets(page);
  const kinds = [...new Set(widgets.map((widget) => widget.kind))];
  const pageText = await frameText();
  const kernelDeclined =
    kernelDeclinedFrom(pageText) ||
    kernelMessages.some((message) => kernelDeclinedFrom(message));
  return {
    kernelDeclined,
    kernelMessages: kernelMessages.slice(-8),
    kinds,
    token: await tokenPresent(),
    widgets,
  };
};
`;

/**
 * Kernel's default stealth solver covers reCAPTCHA and Cloudflare. Visible
 * hCaptcha is a separate beta and, when it is not enabled, Kernel logs
 * "visible hcaptcha could not be solved automatically" and leaves the widget.
 * Inspect only locates the checkbox; the tool clicks with Kernel computer
 * controls so the event is a trusted OS-level mouse action.
 */
export const captchaInspectCode = `${captchaHelpers}
const before = await detect();
if (before.token && !before.kinds.includes("hcaptcha_challenge")) {
  return {
    kernelDeclined: before.kernelDeclined,
    kernelMessages: before.kernelMessages,
    kinds: before.kinds,
    token: true,
    url: page.url(),
  };
}

const checkbox = await checkboxBox();
const target =
  checkbox ??
  before.widgets.find((widget) => widget.kind === "hcaptcha") ??
  before.widgets.find((widget) => widget.kind === "turnstile") ??
  before.widgets.find((widget) => widget.kind === "incapsula");
if (!target || target.kind === "hcaptcha_challenge") {
  return {
    kernelDeclined: before.kernelDeclined,
    kernelMessages: before.kernelMessages,
    kinds: before.kinds,
    token: false,
    url: page.url(),
  };
}

const point = checkbox
  ? {
      x: Math.round(checkbox.box.x + checkbox.box.width / 2),
      y: Math.round(checkbox.box.y + checkbox.box.height / 2),
    }
  : clickPoint(target.box, target.kind);
return {
  clicked: { kind: target.kind, x: point.x, y: point.y },
  kernelDeclined: before.kernelDeclined,
  kernelMessages: before.kernelMessages,
  kinds: before.kinds,
  token: false,
  url: page.url(),
};
`;

export const captchaSettleCode = `${captchaHelpers}
const deadline = Date.now() + 12000;
while (Date.now() < deadline) {
  await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => undefined);
  const after = await detect();
  if (after.token || after.widgets.length === 0) {
    return { challenge: false, kinds: after.kinds, token: after.token || after.widgets.length === 0, url: page.url() };
  }
  if (after.kinds.includes("hcaptcha_challenge")) {
    return { challenge: true, kinds: after.kinds, token: false, url: page.url() };
  }
  await sleep(300);
}
const final = await detect();
return {
  challenge: final.kinds.includes("hcaptcha_challenge"),
  kinds: final.kinds,
  token: final.token || final.widgets.length === 0,
  url: page.url(),
};
`;

export function normalizeCaptchaInspectResult(
  response: PlaywrightExecuteResponse
): z.infer<typeof captchaInspectResultSchema> | undefined {
  if (!response.success) return undefined;
  const parsed = captchaInspectResultSchema.safeParse(response.result);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeCaptchaSettleResult(
  response: PlaywrightExecuteResponse
): z.infer<typeof captchaSettleResultSchema> | undefined {
  if (!response.success) return undefined;
  const parsed = captchaSettleResultSchema.safeParse(response.result);
  return parsed.success ? parsed.data : undefined;
}
