import {
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
import { submitApplication } from "@/lib/application-runner/fill";
import { runApplicationUntilPause } from "@/lib/application-runner/run";
import {
  durableWorkflowRunId,
  isInlineWorkflow,
} from "@/lib/application-runner/types";
import { resumeApplicationHook } from "@/lib/application-runner/workflow";
import { safeApplyUrl } from "@/lib/application-execution";
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
  if (input.approved === true && run.browserSessionId) {
    return submitApplication({
      applyUrl,
      browserSessionId: run.browserSessionId,
      company: run.company,
      executionId: run.id,
      role: run.role,
      rootSessionId: run.rootSessionId,
      scope: input.scope,
    });
  }
  if (run.browserSessionId && (input.answers || input.otp || answered)) {
    return runApplicationUntilPause({
      applyUrl,
      company: run.company,
      executionId: run.id,
      ...(answered ? { resumeAnswered: answered } : {}),
      resumeAnswers: [input.answers, input.otp].filter(Boolean).join("\n"),
      role: run.role,
      rootSessionId: run.rootSessionId,
      scope: input.scope,
    });
  }
  return {
    applyUrl,
    executionId: run.id,
    message: "Continue signal recorded.",
    pause: pauseKindFromOutput({ pause: run.pauseReason ?? undefined }),
    status: run.status,
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
  return {
    executionId: run.id,
    message: "Application cancelled.",
    applyUrl,
    status: "failed" as const,
  };
}
