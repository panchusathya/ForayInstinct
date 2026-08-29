import type { PlaywrightExecuteResponse } from "@onkernel/sdk/resources/browsers";
import { z } from "zod";

const captchaKindSchema = z.enum([
  "hcaptcha",
  "hcaptcha_challenge",
  "incapsula",
  "turnstile",
]);

export const captchaSolveResultSchema = z.object({
  clicked: z
    .object({
      kind: z.enum(["hcaptcha", "incapsula", "turnstile"]),
      x: z.number(),
      y: z.number(),
    })
    .optional(),
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

/**
 * Checkbox CAPTCHAs (hCaptcha, Imperva/Incapsula interstitials, uncleared
 * Turnstile) need a trusted CDP mouse event. Playwright locator clicks set
 * isTrusted=false and fail those widgets. Kernel's managed solver covers
 * reCAPTCHA and many Cloudflare challenges; this script is the checkbox
 * fallback after that wait.
 */
export const captchaSolverCode = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const detect = async () => {
  const widgets = await collectWidgets(page);
  const kinds = [...new Set(widgets.map((widget) => widget.kind))];
  return { kinds, token: await tokenPresent(), widgets };
};

const dispatchTrustedClick = async (x, y) => {
  let session;
  try {
    session = await context.newCDPSession(page);
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(40);
    await session.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x,
      y,
    });
    await sleep(32);
    await session.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x,
      y,
    });
  } finally {
    if (session) await session.detach().catch(() => undefined);
  }
};

const before = await detect();
if (before.token && !before.kinds.includes("hcaptcha_challenge")) {
  return { kinds: before.kinds, state: "already_solved", url: page.url() };
}
if (before.widgets.length === 0) {
  return { kinds: [], state: "not_found", url: page.url() };
}
if (before.kinds.includes("hcaptcha_challenge") && !before.kinds.includes("hcaptcha")) {
  return { kinds: before.kinds, state: "challenge_required", url: page.url() };
}

const checkbox = await checkboxBox();
const target =
  checkbox ??
  before.widgets.find((widget) => widget.kind === "hcaptcha") ??
  before.widgets.find((widget) => widget.kind === "turnstile") ??
  before.widgets.find((widget) => widget.kind === "incapsula");
if (!target || target.kind === "hcaptcha_challenge") {
  return { kinds: before.kinds, state: "challenge_required", url: page.url() };
}

const point = checkbox
  ? {
      x: Math.round(checkbox.box.x + checkbox.box.width / 2),
      y: Math.round(checkbox.box.y + checkbox.box.height / 2),
    }
  : clickPoint(target.box, target.kind);
const clicked = { kind: target.kind, x: point.x, y: point.y };

try {
  await dispatchTrustedClick(point.x, point.y);
} catch {
  await page.mouse.click(point.x, point.y, { delay: 32 });
}

const deadline = Date.now() + 12000;
while (Date.now() < deadline) {
  await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => undefined);
  const after = await detect();
  if (after.token || after.widgets.length === 0) {
    return { clicked, kinds: after.kinds.length > 0 ? after.kinds : before.kinds, state: "solved", url: page.url() };
  }
  if (after.kinds.includes("hcaptcha_challenge")) {
    return { clicked, kinds: after.kinds, state: "challenge_required", url: page.url() };
  }
  await sleep(300);
}

const final = await detect();
return {
  clicked,
  kinds: final.kinds,
  state: final.token || final.widgets.length === 0 ? "solved" : "unsolved",
  url: page.url(),
};
`;

export function normalizeCaptchaSolveResult(
  response: PlaywrightExecuteResponse
): z.infer<typeof captchaSolveResultSchema> {
  if (!response.success) {
    return { kinds: [], state: "execution_failed" };
  }
  const parsed = captchaSolveResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return { kinds: [], state: "execution_failed" };
  }
  return parsed.data;
}
