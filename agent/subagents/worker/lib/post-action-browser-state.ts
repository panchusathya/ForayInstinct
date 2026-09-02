import { z } from "zod";
import { browserProvider } from "@/lib/browser";

const postActionBrowserStateSchema = z.object({
  botOrChallenge: z.boolean(),
  emailOtp: z.boolean(),
  otpHint: z.string().optional(),
  smsOtp: z.boolean(),
  submitted: z.boolean(),
});

export type PostActionBrowserState = z.infer<
  typeof postActionBrowserStateSchema
>;

/**
 * Browser actions can leave an ATS on a different tab or inside an iframe.
 * Page copy is not a sensor: "Enter your zip code" is not an OTP, a reCAPTCHA
 * footer is not a challenge, and "we received your application" on a posting
 * is not a confirmation. OTP requires `autocomplete=one-time-code`, a bot
 * wall requires a visible CAPTCHA iframe, and submit requires a confirmation
 * URL. This probe returns only those labels and a safe site hint.
 */
export const postActionBrowserStateProbeCode = `
const inspect = () => {
  const state = {
    botOrChallenge: false,
    emailOtp: false,
    otpHint: undefined,
    smsOtp: false,
    submitted: false,
  };
  const visible = (node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const otpInputs = [...document.querySelectorAll("input, textarea")]
    .filter(visible)
    .filter((node) => (node.getAttribute("autocomplete") || "").toLowerCase().includes("one-time-code"));
  if (otpInputs.length > 0) {
    const around = otpInputs.map((node) => [
      node.getAttribute("autocomplete"),
      node.getAttribute("name"),
      node.getAttribute("id"),
      node.getAttribute("placeholder"),
      node.getAttribute("aria-label"),
      node.getAttribute("type"),
    ].filter(Boolean).join(" ")).join(" ").toLowerCase();
    const email = /email|e-mail|inbox/.test(around);
    const sms = /sms|phone|mobile|tel/.test(around);
    if (sms && !email) state.smsOtp = true;
    else state.emailOtp = true;
    const source = /greenhouse/iu.test(location.hostname) ? "Greenhouse" : location.hostname;
    state.otpHint ??= source;
  }
  if (/applicationSubmitted|\\/confirmation(?:\\/|$)/i.test(location.href)) {
    state.submitted = true;
  }
  const captchaSrc = (value) => /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare/.test(String(value || "").toLowerCase());
  const challengeFrame = captchaSrc(location.href) && /bframe|challenge|captcha/i.test(location.href);
  const captchaIframe = [...document.querySelectorAll("iframe")].some((node) => {
    if (!visible(node)) return false;
    if (!captchaSrc(node.getAttribute("src") || node.src)) return false;
    const box = node.getBoundingClientRect();
    return box.height >= 80 && box.width >= 80;
  });
  if (challengeFrame || captchaIframe) state.botOrChallenge = true;
  return state;
};
const state = {
  botOrChallenge: false,
  emailOtp: false,
  otpHint: undefined,
  smsOtp: false,
  submitted: false,
};
for (const context of browser.contexts()) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const found = await frame.evaluate(inspect).catch(() => undefined);
      if (!found) continue;
      state.botOrChallenge ||= found.botOrChallenge;
      state.emailOtp ||= found.emailOtp;
      state.smsOtp ||= found.smsOtp;
      state.submitted ||= found.submitted;
      state.otpHint ??= found.otpHint;
    }
  }
}
return state;`;

export async function inspectPostActionBrowserState(
  sessionId: string,
  signal?: AbortSignal
): Promise<PostActionBrowserState | undefined> {
  const response = await browserProvider
    .executePlaywright(
      sessionId,
      { code: postActionBrowserStateProbeCode, timeoutSec: 10 },
      signal
    )
    .catch(() => undefined);
  const parsed = postActionBrowserStateSchema.safeParse(response?.result);
  return parsed.success ? parsed.data : undefined;
}

export function postActionBrowserStateInstruction(
  state: PostActionBrowserState | undefined
) {
  if (!state) return undefined;
  if (state.emailOtp) {
    return "An email verification code is now required. Preserve this browser and finish with `Needs email OTP:` including the site hint. Do not refill, resubmit, screenshot, or retry the form.";
  }
  if (state.smsOtp) {
    return "An SMS verification code is now required. Preserve this browser and finish with `Needs user input:`. Do not refill, resubmit, screenshot, or retry the form.";
  }
  if (state.botOrChallenge) {
    return "A bot-detection or CAPTCHA challenge is visible. Preserve this browser and report the blocker; do not refill or retry the form.";
  }
  return undefined;
}
