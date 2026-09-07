import {
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
import { submitApplication } from "@/lib/application-runner/fill";
import { runApplicationUntilPause } from "@/lib/application-runner/run";
import type { ApplicationRunInput } from "@/lib/application-runner/types";
import { env } from "@/lib/env";

export interface ApplicationHookPayload {
  action?: "cancel" | "continue";
  answered?: Record<string, string>;
  answers?: string;
  approved?: boolean;
  otp?: string;
}

export async function fillApplicationWorkflow(input: ApplicationRunInput) {
  "use workflow";
  let current = input;
  for (let step = 0; step < 8; step += 1) {
    const paused = await runUntilPauseStep(current);
    if (!("pause" in paused)) return paused;
    const payload = await waitForContinue(input.executionId);
    if (payload.action === "cancel" || payload.approved === false) {
      await cancelRunStep(current);
      return { done: true, message: "Application cancelled." };
    }
    if (payload.approved === true) {
      // Answers first, approval second, as continue.ts does: a reply sent in
      // the same breath as a yes used to be dropped here and the form
      // submitted exactly as incomplete as it had just been reported.
      if (payload.answered || payload.answers) {
        current = withResume(current, payload);
        const filled = await runUntilPauseStep(current);
        if (!("pause" in filled)) return filled;
        if (filled.pause === "user_input") continue;
      }
      // A submit can open a verification step; that is a pause like any
      // other, resolved by the next payload's code.
      const submitted = await submitStep(current);
      if (!("pause" in submitted)) return submitted;
      continue;
    }
    current = withResume(current, payload);
  }
  return { done: true, message: "Application run paused too many times." };
}

/** The next round's input: the run as it was, plus what the candidate sent. */
function withResume(
  current: ApplicationRunInput,
  payload: ApplicationHookPayload
): ApplicationRunInput {
  return {
    applyUrl: current.applyUrl,
    company: current.company,
    executionId: current.executionId,
    ...(payload.answered ? { resumeAnswered: payload.answered } : {}),
    resumeAnswers: payload.answers ?? "",
    ...(payload.otp ? { resumeOtp: payload.otp } : {}),
    role: current.role,
    rootSessionId: current.rootSessionId,
    scope: current.scope,
  };
}

/**
 * Claims the run for the durable Workflow SDK when it is available, and
 * otherwise reports inline ownership so the caller drives the fill itself.
 *
 * This never starts the fill in the background. Agent tools run inside eve's
 * Nitro bundle, where a detached promise dies as soon as the tool's response
 * flushes, so a fire-and-forget run silently abandoned the browser session.
 */
export async function startApplicationWorkflow(input: ApplicationRunInput) {
  if (env.NODE_ENV === "test") {
    return `inline:${input.executionId}`;
  }
  try {
    const workflowApi = await import("workflow/api");
    const run = await workflowApi.start(fillApplicationWorkflow, [input]);
    return run.runId;
  } catch (error) {
    console.error(
      "[application-runner] workflow start unavailable; running inline",
      {
        error: error instanceof Error ? error.message : "unknown",
      }
    );
    return `inline:${input.executionId}`;
  }
}

function applicationHookToken(executionId: string) {
  return `application:${executionId}`;
}

export async function resumeApplicationHook(
  executionId: string,
  payload: ApplicationHookPayload
) {
  try {
    const workflowApi = await import("workflow/api");
    await workflowApi.resumeHook(applicationHookToken(executionId), payload);
  } catch {
    // Inline / test runs have no hook world; continue_application drives steps.
  }
}

async function waitForContinue(executionId: string) {
  const workflow = await import("workflow");
  const hook = workflow.createHook<ApplicationHookPayload>({
    token: applicationHookToken(executionId),
  });
  return await hook;
}

async function runUntilPauseStep(input: ApplicationRunInput) {
  "use step";
  return runApplicationUntilPause(input);
}

async function submitStep(input: ApplicationRunInput) {
  "use step";
  const run = await findApplicationRun({
    applyUrl: input.applyUrl,
    scope: input.scope,
  });
  if (!run?.browserSessionId) {
    throw new Error("Application runner requires an open browser session.");
  }
  return submitApplication({
    ...input,
    browserSessionId: run.browserSessionId,
  });
}

async function cancelRunStep(input: ApplicationRunInput) {
  "use step";
  const run = await findApplicationRun({
    applyUrl: input.applyUrl,
    scope: input.scope,
  });
  if (run?.browserSessionId) {
    await closeApplicationBrowser({
      scope: input.scope,
      sessionId: run.browserSessionId,
    });
  }
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: null,
    status: "failed",
  });
}
