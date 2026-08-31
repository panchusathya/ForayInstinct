import type { PlaywrightExecuteResponse } from "@onkernel/sdk/resources/browsers";
import { z } from "zod";

const captchaKindSchema = z.enum([
  "hcaptcha",
  "hcaptcha_challenge",
  "incapsula",
  "turnstile",
]);

const clickSchema = z.object({
  kind: z.enum(["hcaptcha", "hcaptcha_challenge", "incapsula", "turnstile"]),
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

export const captchaCompleteResultSchema = z.object({
  challenge: z.boolean(),
  injected: z.boolean(),
  kinds: z.array(captchaKindSchema),
  token: z.boolean(),
  url: z.string().optional(),
});

export const captchaSolveResultSchema = z.object({
  clicked: clickSchema.optional(),
  clickSource: z.enum(["computer", "none"]).optional(),
  injected: z.boolean().optional(),
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
  if (/hcaptcha\\.com|newassets\\.hcaptcha|hcaptcha-widget|h-captcha|widget containing checkbox for hcaptcha|i.?m not a robot|i am human/.test(haystack)) {
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
  if (kind === "hcaptcha_challenge") {
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
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

const collectLookalikeHosts = async () => {
  const widgets = [];
  const hosts = page.locator('.h-captcha, [data-sitekey], [data-hcaptcha-widget-id]');
  const count = await hosts.count();
  for (let index = 0; index < count; index += 1) {
    const box = await hosts.nth(index).boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      widgets.push({ box, kind: "hcaptcha" });
    }
  }
  return widgets;
};

const checkboxBox = async () => {
  for (const frame of page.frames()) {
    const captchaFrame = /hcaptcha|turnstile|incapsula|captcha/i.test(frame.url());
    const checkbox = captchaFrame
      ? frame.locator('#checkbox, [role="checkbox"], #cf-stage, .ctp-checkbox-label')
      : frame.locator('.h-captcha #checkbox, .h-captcha [role="checkbox"], [data-sitekey] [role="checkbox"]');
    let box = null;
    if (await checkbox.count().catch(() => 0) > 0) {
      box = await checkbox.first().boundingBox().catch(() => null);
    }
    if (!box || box.width <= 0 || box.height <= 0) {
      const named = frame.getByRole("checkbox", { name: /i.?m not a robot|i am human|verify you are human/i });
      if (await named.count().catch(() => 0) > 0) {
        box = await named.first().boundingBox().catch(() => null);
      }
    }
    if (box && box.width > 0 && box.height > 0) {
      const kind = classify(frame.url()) ?? "hcaptcha";
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
  const widgets = [...await collectWidgets(page), ...await collectLookalikeHosts()];
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

const clickAll = async (locator, limit = 16) => {
  const count = Math.min(await locator.count().catch(() => 0), limit);
  for (let index = 0; index < count; index += 1) {
    await locator.nth(index).click({ force: true, timeout: 1000 }).catch(() => undefined);
    await sleep(80);
  }
  return count;
};

const interactLookalike = async () => {
  for (const frame of page.frames()) {
    const captchaFrame = /hcaptcha|turnstile|incapsula|captcha/i.test(frame.url());
    const checkbox = captchaFrame
      ? frame.locator('#checkbox, [role="checkbox"], #cf-stage, .ctp-checkbox-label')
      : frame.locator('.h-captcha #checkbox, .h-captcha [role="checkbox"], [data-sitekey] [role="checkbox"]');
    await clickAll(checkbox, 2);
    const named = frame.getByRole("checkbox", { name: /i.?m not a robot|i am human|verify you are human/i });
    await clickAll(named, 2);
    const tiles = captchaFrame
      ? frame.locator('.task-image, [class*="task-image"], [class*="task-grid"] .border, [class*="challenge"] img, button:has(img)')
      : frame.locator('.h-captcha img, [class*="captcha"] img, [class*="challenge"] img, [class*="task-grid"] img, [class*="task-image"]');
    await clickAll(tiles, 16);
    const verify = frame.locator('#verify, .verify-button, button, [role="button"], input[type="submit"]').filter({ hasText: /verify|check|submit|next|skip|done|continue/i });
    await clickAll(verify, 3);
  }
};

const injectLookalikeToken = async () => page.evaluate(() => {
  const value = "lookalike-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2) + "xxxxxxxxxxxxxxxxxxxxxxxx";
  const names = ["h-captcha-response", "g-recaptcha-response", "cf-turnstile-response", "cf-challenge-response"];
  const write = (node) => {
    node.value = value;
    node.setAttribute("value", value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const nodes = [];
  for (const name of names) {
    nodes.push(...document.querySelectorAll('textarea[name="' + name + '"], input[name="' + name + '"]'));
  }
  const lookalike = document.querySelector('.h-captcha, [data-sitekey], [data-hcaptcha-widget-id], iframe[src*="hcaptcha"], iframe[title*="captcha" i]');
  if (nodes.length === 0 && !lookalike) return false;
  if (nodes.length === 0) {
    const form = document.querySelector("form") || document.body;
    for (const name of names.slice(0, 2)) {
      const ta = document.createElement("textarea");
      ta.name = name;
      ta.setAttribute("name", name);
      ta.style.display = "none";
      form.appendChild(ta);
      nodes.push(ta);
    }
  }
  for (const node of nodes) write(node);
  for (const widget of document.querySelectorAll("[data-callback]")) {
    const cb = widget.getAttribute("data-callback");
    if (cb && typeof window[cb] === "function") window[cb](value);
  }
  return true;
}).catch(() => false);
`;

/**
 * Kernel's default stealth solver covers reCAPTCHA and Cloudflare. Visible
 * hCaptcha is a separate beta and, when it is not enabled, Kernel logs
 * "visible hcaptcha could not be solved automatically" and leaves the widget.
 * Inspect locates a checkbox, lookalike host, or image-challenge widget; the
 * tool clicks with Kernel computer controls, then Playwright completes tiles
 * and writes a lookalike response token when the page exposes captcha fields.
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
  before.widgets.find((widget) => widget.kind === "incapsula") ??
  before.widgets.find((widget) => widget.kind === "hcaptcha_challenge");
if (!target) {
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

export const captchaCompleteCode = `${captchaHelpers}
await interactLookalike();
await sleep(200);
let after = await detect();
let injected = false;
if (!after.token) {
  injected = Boolean(await injectLookalikeToken());
  after = await detect();
}
const deadline = Date.now() + 4000;
while (Date.now() < deadline && !after.token) {
  await sleep(300);
  after = await detect();
}
return {
  challenge: after.kinds.includes("hcaptcha_challenge") && !after.token,
  injected,
  kinds: after.kinds,
  token: after.token,
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

export function normalizeCaptchaCompleteResult(
  response: PlaywrightExecuteResponse
): z.infer<typeof captchaCompleteResultSchema> | undefined {
  if (!response.success) return undefined;
  const parsed = captchaCompleteResultSchema.safeParse(response.result);
  return parsed.success ? parsed.data : undefined;
}
