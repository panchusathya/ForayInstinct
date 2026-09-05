import {
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
import { submitApplication } from "@/lib/application-runner/fill";
import { runApplicationUntilPause } from "@/lib/application-runner/run";
import {
  type ApplicationRunInput,
  durableWorkflowRunId,
  isInlineWorkflow,
  looksLikeVerificationCode,
} from "@/lib/application-runner/types";
import { resumeApplicationHook } from "@/lib/application-runner/workflow";
import { describeBrowserSessionFailure } from "@/agent/subagents/worker/lib/challenge-diagnostics";
import {
  applicationExecutionLog,
  safeApplyUrl,
} from "@/lib/application-execution";
import { forgetRunAnswers } from "@/lib/manager/server/application-answers";
import type { AccessScope } from "@/lib/access-scope";
import { pauseKindFromOutput } from "@/lib/task-completion";

export async function continueApplication(input: {
  answered?: Record<string, string>;
  answers?: string;
  applyUrl: string;
  approved?: boolean;
  otp?: string;
  scope: AccessScope;
}) {
  const applyUrl = safeApplyUrl(input.applyUrl);
  const run = await findApplicationRun({ applyUrl, scope: input.scope });
  if (!run) {
    throw new Error("No application run found for that posting URL.");
  }
  const answered =
    input.answered && Object.keys(input.answered).length > 0
      ? input.answered
      : undefined;
  await resumeApplicationHook(run.id, {
    action: "continue",
    answered,
    answers: input.answers,
    approved: input.approved,
    otp: input.otp,
  });
  if (!isInlineWorkflow(run.workflowRunId)) {
    return {
      applyUrl,
      executionId: run.id,
      message: "Continue signal recorded.",
      pause: pauseKindFromOutput({ pause: run.pauseReason ?? undefined }),
      status: "waiting" as const,
    };
  }
  const base = {
    applyUrl,
    company: run.company,
    executionId: run.id,
    role: run.role,
    rootSessionId: run.rootSessionId,
    scope: input.scope,
  };
  const carried = {
    ...(answered ? { resumeAnswered: answered } : {}),
    ...(input.answers ? { resumeAnswers: input.answers } : {}),
  };
  // A verification code, however it was sent: the `otp` field, a bare code
  // as free text, or a lone answer that reads as one. Whether the page is
  // asking for a code is decided at the page, not from the last pause: the
  // pause a code dialog produced was once a plain "blocked submit".
  const typedOtp = input.otp?.trim();
  const code =
    typedOtp !== undefined && typedOtp !== ""
      ? typedOtp
      : verificationCodeAmong(input.answers, answered);
  try {
    if (code && run.browserSessionId) {
      return await runApplicationUntilPause({
        ...base,
        // A code typed into the otp field travels alone; one read out of an
        // answer keeps the answer with it, in case it was an answer after all.
        ...(typedOtp ? {} : carried),
        resumeOtp: code,
      });
    }
    if (input.approved === true && run.browserSessionId) {
      // Answers first, approval second. Approval used to short-circuit
      // straight to the click, so replies sent in the same breath as a yes
      // were dropped and the form was submitted exactly as incomplete as it
      // had just been reported. Filling first also refreshes the page's own
      // blank check, which is what stops a submit the page would only refuse.
      if (answered || input.answers) {
        const filled = await runApplicationUntilPause({ ...base, ...carried });
        // Still short, or now waiting on the review it just captured: either
        // way the candidate has something to see before anything is sent.
        if ("pause" in filled && filled.pause === "user_input") return filled;
      }
      return await submitApplication({
        ...base,
        browserSessionId: run.browserSessionId,
      });
    }
    if (run.browserSessionId && (input.answers || answered)) {
      return await runApplicationUntilPause({ ...base, ...carried });
    }
  } catch (error) {
    if (!isBrowserGone(error)) throw error;
    return refillAfterLostBrowser({ ...base, ...carried }, error);
  }
  return {
    applyUrl,
    executionId: run.id,
    message: "Continue signal recorded.",
    pause: pauseKindFromOutput({ pause: run.pauseReason ?? undefined }),
    status: run.status,
  };
}

/** A code hidden among ordinary replies, if exactly one reply reads as one. */
function verificationCodeAmong(
  answers: string | undefined,
  answered: Record<string, string> | undefined
) {
  if (answers && looksLikeVerificationCode(answers)) return answers.trim();
  const values = Object.values(answered ?? {});
  const [only] = values;
  if (
    values.length === 1 &&
    only !== undefined &&
    looksLikeVerificationCode(only)
  ) {
    return only.trim();
  }
  return undefined;
}

/** A browser the backend no longer has, as either backend reports it. */
function isBrowserGone(error: unknown) {
  const failure = describeBrowserSessionFailure(error);
  return failure === "session_gone" || failure === "session_not_found";
}

/**
 * Opens a fresh browser and fills the form again when the last browser died.
 *
 * Brightdata dropped one twelve minutes in, between the review screenshot
 * and the candidate's approval; the tool threw, the agent retried into the
 * same dead session, then started over and asked every question again. The
 * profile and the run's remembered answers carry the form back to where it
 * was, and the candidate hears once that it happened.
 */
async function refillAfterLostBrowser(
  input: ApplicationRunInput,
  error: unknown
) {
  applicationExecutionLog({
    apply_url: input.applyUrl,
    error: (error instanceof Error ? error.message : "unknown").slice(0, 200),
    event: "browser.gone",
    execution_id: input.executionId,
  });
  await updateApplicationRun({
    browserSessionId: "",
    executionId: input.executionId,
  });
  const refilled = await runApplicationUntilPause(input);
  if (!("message" in refilled)) return refilled;
  return {
    ...refilled,
    message: `${refilled.message} The previous browser session had expired, so the form was filled again in a new one.`,
  };
}

export async function cancelApplication(input: {
  applyUrl: string;
  scope: AccessScope;
}) {
  const applyUrl = safeApplyUrl(input.applyUrl);
  const run = await findApplicationRun({ applyUrl, scope: input.scope });
  if (!run) {
    throw new Error("No application run found for that posting URL.");
  }
  await resumeApplicationHook(run.id, { action: "cancel" });
  if (run.browserSessionId) {
    await closeApplicationBrowser({
      scope: input.scope,
      sessionId: run.browserSessionId,
    });
  }
  const durableRunId = durableWorkflowRunId(run.workflowRunId);
  if (durableRunId) {
    try {
      const workflowApi = await import("workflow/api");
      await workflowApi.getRun(durableRunId).cancel();
    } catch {
      // Best-effort cancel of the durable run.
    }
  }
  await updateApplicationRun({
    executionId: run.id,
    pauseReason: null,
    status: "failed",
  });
  await forgetRunAnswers(input.scope, run.id).catch(() => undefined);
  return {
    executionId: run.id,
    message: "Application cancelled.",
    applyUrl,
    status: "failed" as const,
  };
}
