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
      await cancelRunStep(input);
      return { done: true, message: "Application cancelled." };
    }
    if (payload.approved === true) {
      return submitStep(input);
    }
    current = {
      applyUrl: current.applyUrl,
      company: current.company,
      executionId: current.executionId,
      resumeAnswers: [payload.answers, payload.otp].filter(Boolean).join("\n"),
      role: current.role,
      rootSessionId: current.rootSessionId,
      scope: current.scope,
    };
  }
  return { done: true, message: "Application run paused too many times." };
}

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
      "[application-runner] workflow start failed; running inline",
      {
        error: error instanceof Error ? error.message : "unknown",
      }
    );
    void runApplicationUntilPause(input).catch((cause: unknown) => {
      console.error("[application-runner] inline run failed", {
        error: cause instanceof Error ? cause.message : "unknown",
      });
    });
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
