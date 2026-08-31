import {
  captchaProbeCode,
  normalizeCaptchaProbeResult,
} from "@/agent/subagents/worker/lib/captcha-solver";
import { deleteBrowserSession } from "@/db/services/browsers";
import type { AccessScope } from "@/lib/access-scope";
import { kernel } from "@/lib/kernel";

/**
 * Why a browser call could not reach the page, split by the layer that
 * rejected it. `session_not_owned` comes from the local row being absent, so
 * Kernel was never called; the other two mean the row was there and Kernel
 * rejected the session itself. A dead session and a blocking CAPTCHA both
 * surface to the model as an ordinary tool failure, so without this the two are
 * indistinguishable after the fact.
 */
export function describeBrowserSessionFailure(error: unknown) {
  if (typeof error === "object" && error !== null) {
    if ("status" in error) {
      if (error.status === 410) return "session_gone";
      if (error.status === 404) return "session_not_found";
    }
    if (
      "error" in error &&
      typeof error.error === "object" &&
      error.error !== null &&
      "code" in error.error
    ) {
      if (error.error.code === "session_gone") return "session_gone";
      if (error.error.code === "not_found") return "session_not_found";
    }
  }
  if (
    error instanceof Error &&
    error.message === browserSessionNotOwnedMessage
  ) {
    return "session_not_owned";
  }
  return;
}

export const browserSessionNotOwnedMessage = "Browser session not found.";

/** Kernel has reclaimed the session, whatever the local row still says. */
export function isKernelSessionDead(
  failure: ReturnType<typeof describeBrowserSessionFailure>
) {
  return failure === "session_gone" || failure === "session_not_found";
}

/**
 * The model sees only the error text, so a raw Kernel string ("410 browser
 * session no longer exists") reads as a transient fault worth retrying. It is
 * not: the session is unrecoverable, and retrying it is what turns one dead
 * browser into a whole turn of failing tool calls.
 */
export function browserSessionEndedError(sessionId: string) {
  return new Error(
    `Browser session ${sessionId} has ended and cannot be reused. Create a new browser with manage_browsers before retrying, and do not reuse this session_id.`
  );
}

/**
 * Drops the local row once Kernel has reclaimed the session, so the two layers
 * converge. Afterwards the ownership check fails immediately instead of every
 * tool making its own doomed Kernel round trip.
 */
export async function forgetDeadBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  try {
    await deleteBrowserSession(scope, sessionId);
  } catch (error: unknown) {
    // Reconciliation is best effort; it must not mask the original failure.
    console.warn("[browser-session] could not drop the stale row", {
      browser_session_id: sessionId,
      error: error instanceof Error ? error.message : "delete failed",
      workspace_id: scope.workspaceId,
    });
  }
}

/**
 * Handles a failed browser call: reconciles a dead session and returns the
 * error to surface, or probes the page for a challenge when the session is
 * still alive. Returning the replacement error keeps the decision in one place
 * rather than repeated at each tool.
 */
export async function handleBrowserToolFailure(input: {
  readonly error: unknown;
  readonly scope: AccessScope;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly tool: string;
  readonly trigger: string;
}) {
  const failure = describeBrowserSessionFailure(input.error);
  if (failure === undefined) {
    await logChallengeProbe({
      sessionId: input.sessionId,
      signal: input.signal,
      trigger: input.trigger,
      workspaceId: input.scope.workspaceId,
    });
    return input.error;
  }
  console.warn("[browser-session] unusable", {
    browser_session_id: input.sessionId,
    reason: failure,
    tool: input.tool,
    workspace_id: input.scope.workspaceId,
  });
  if (isKernelSessionDead(failure)) {
    await forgetDeadBrowserSession(input.scope, input.sessionId);
  }
  return browserSessionEndedError(input.sessionId);
}

/**
 * Records whether a challenge widget was on screen at a moment the worker could
 * not make progress. The probe is read-only, and its own failure is the other
 * half of the answer: a `session_gone` here means the session died before any
 * CAPTCHA could have been missed.
 */
export async function logChallengeProbe(input: {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly trigger: string;
  readonly workspaceId: string;
}) {
  try {
    const probe = normalizeCaptchaProbeResult(
      await kernel.browsers.playwright.execute(
        input.sessionId,
        { code: captchaProbeCode, timeout_sec: 10 },
        { signal: input.signal }
      )
    );
    if (!probe) {
      console.warn("[challenge-probe] page could not be observed", {
        browser_session_id: input.sessionId,
        trigger: input.trigger,
        workspace_id: input.workspaceId,
      });
      return;
    }
    console.info("[challenge-probe] observed", {
      browser_session_id: input.sessionId,
      challenge_present: probe.kinds.length > 0,
      kernel_declined: probe.kernelDeclined,
      kinds: probe.kinds,
      token: probe.token,
      trigger: input.trigger,
      url: probe.url,
      workspace_id: input.workspaceId,
    });
  } catch (error: unknown) {
    // A diagnostic must never change the outcome of the call that triggered it.
    console.warn("[challenge-probe] could not reach the page", {
      browser_session_id: input.sessionId,
      reason: describeBrowserSessionFailure(error) ?? "probe_failed",
      trigger: input.trigger,
      workspace_id: input.workspaceId,
    });
  }
}
