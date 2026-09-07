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
  liveRunStatuses,
  looksLikeVerificationCode,
} from "@/lib/application-runner/types";
import { resumeApplicationHook } from "@/lib/application-runner/workflow";
import {
  describeBrowserSessionFailure,
  isBrowserSessionDead,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";
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
  // A run that already ended takes no more input. A second "yes" on a
  // completed run used to reach submitApplication again, and with the
  // confirmation page's own Apply buttons in reach that was a second
  // application, or a click on something unrelated.
  if (!liveRunStatuses.has(run.status)) {
    if (run.status === "completed") {
      return {
        applyUrl,
        done: true as const,
        executionId: run.id,
        message: `The application for ${run.role} at ${applyUrl} was already submitted; there is nothing to continue.`,
        status: "completed" as const,
      };
    }
    return {
      applyUrl,
      executionId: run.id,
      message: `This run ended (${run.status}) and cannot be continued. Start it again with start_application.`,
      status: run.status,
    };
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
  // A run whose browser is gone still owes the candidate an answer. The
  // approval and answers branches used to require a live session and fall
  // through to "Continue signal recorded" without one, so a yes sent after
  // the watchdog reaped the browser did nothing, forever.
  const browserSessionId =
    typeof run.browserSessionId === "string" ? run.browserSessionId : "";
  const live = browserSessionId !== "";
  try {
    if (code) {
      if (!live) {
        // The dialog that asked for the code died with its browser; the code
        // is stale. Fill again and let the page ask afresh.
        return await refillAfterLostBrowser(
          { ...base, ...carried },
          "the browser that asked for the code is gone"
        );
      }
      return await runApplicationUntilPause({
        ...base,
        // A code typed into the otp field travels alone; one read out of an
        // answer keeps the answer with it, in case it was an answer after all.
        ...(typedOtp ? {} : carried),
        resumeOtp: code,
      });
    }
    if (input.approved === true) {
      if (!live) {
        // The candidate approved a form whose browser has since gone. Fill
        // it again from the profile and the run's remembered answers, and
        // when that comes back ready for approval, send it: the approval was
        // given for this form, and asking for it a second time is the loop
        // the candidate experienced as being ignored.
        const refilled = await refillAfterLostBrowser(
          { ...base, ...carried },
          "no browser session for the approved run"
        );
        if (!("pause" in refilled) || refilled.pause !== "approval") {
          return refilled;
        }
        const reopened = await findApplicationRun({
          applyUrl,
          scope: input.scope,
        });
        if (!reopened?.browserSessionId) return refilled;
        const submitted = await submitApplication({
          ...base,
          browserSessionId: reopened.browserSessionId,
        });
        return "message" in submitted
          ? { ...submitted, message: `${submitted.message} ${lostBrowserNote}` }
          : submitted;
      }
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
        browserSessionId,
      });
    }
    if (input.answers || answered) {
      if (!live) {
        return await refillAfterLostBrowser(
          { ...base, ...carried },
          "no browser session for the answered run"
        );
      }
      return await runApplicationUntilPause({ ...base, ...carried });
    }
  } catch (error) {
    if (!isBrowserGone(error)) throw error;
    return refillAfterLostBrowser(
      { ...base, ...carried },
      error instanceof Error ? error.message : "unknown"
    );
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

/**
 * A browser the backend no longer has, as either backend reports it. The
 * gateway's sessions are pinned to one registrable domain, and a form that
 * hops to the employer's own site kills one with `cross_domain_navigation`;
 * that death was missed here, so the recovery written for it never ran.
 */
function isBrowserGone(error: unknown) {
  return isBrowserSessionDead(describeBrowserSessionFailure(error));
}

const lostBrowserNote =
  "The previous browser session had expired, so the form was filled again in a new one.";

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
  reason: string
) {
  applicationExecutionLog({
    apply_url: input.applyUrl,
    error: reason.slice(0, 200),
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
    message: `${refilled.message} ${lostBrowserNote}`,
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
