import { z } from "zod";
import { kernel } from "@/lib/kernel";

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
 * Inspecting only the page a locator just touched is how an emailed Greenhouse
 * OTP gets mistaken for a recoverable form error and the worker starts over.
 * This probe intentionally returns only state labels and a safe site hint, not
 * form values, page text, or any code that might be on screen.
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
  const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 30000);
  const lower = text.toLowerCase();
  const controls = [...document.querySelectorAll("input, textarea, [contenteditable='true']")]
    .filter(visible);
  const otp = controls.some((node) => {
    const value = [
      node.getAttribute("autocomplete"),
      node.getAttribute("name"),
      node.getAttribute("id"),
      node.getAttribute("placeholder"),
      node.getAttribute("aria-label"),
      node.getAttribute("type"),
    ].filter(Boolean).join(" ").toLowerCase();
    return value.includes("one-time-code") || /(?:otp|verification|security|passcode|one.?time)/.test(value);
  });
  const otpPrompt = /(?:enter|type|provide|confirm).{0,80}(?:otp|verification|security|passcode|one.?time|code)/.test(lower)
    || /(?:otp|verification|security|passcode|one.?time).{0,80}(?:code|sent|enter|type)/.test(lower);
  if (otp || otpPrompt) {
    const email = /(?:email|inbox|e-mail).{0,90}(?:code|verification|otp)|(?:code|verification|otp).{0,90}(?:email|inbox|e-mail)/.test(lower);
    const sms = /(?:sms|text message|mobile number|phone).{0,90}(?:code|verification|otp)|(?:code|verification|otp).{0,90}(?:sms|text message|mobile number|phone)/.test(lower);
    if (email || !sms) state.emailOtp = true;
    if (sms && !email) state.smsOtp = true;
    const source = /greenhouse/iu.test(location.hostname) ? "Greenhouse" : location.hostname;
    state.otpHint ??= source;
  }
  if (/application.{0,80}(?:successfully )?(?:submitted|received)|(?:successfully )?(?:submitted|received).{0,80}application/.test(lower)
      || /applicationSubmitted|\\/confirmation(?:\\/|$)/i.test(location.href)) {
    state.submitted = true;
  }
  if (/(?:captcha|i.?m not a robot|verify (?:you are )?human|unusual activity|automated (?:traffic|behavior)|bot (?:detection|error)|access denied)/.test(lower)) {
    state.botOrChallenge = true;
  }
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
  const response = await kernel.browsers.playwright
    .execute(
      sessionId,
      { code: postActionBrowserStateProbeCode, timeout_sec: 10 },
      { signal }
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
