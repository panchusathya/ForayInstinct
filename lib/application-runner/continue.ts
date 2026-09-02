import {
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
import { submitApplication } from "@/lib/application-runner/fill";
import { runApplicationUntilPause } from "@/lib/application-runner/run";
import { resumeApplicationHook } from "@/lib/application-runner/workflow";
import { safeApplyUrl } from "@/lib/application-execution";
import type { AccessScope } from "@/lib/access-scope";
import { pauseKindFromOutput } from "@/lib/task-completion";

function isInlineWorkflow(workflowRunId: string | null | undefined) {
  return (
    workflowRunId === undefined ||
    workflowRunId === null ||
    workflowRunId.startsWith("inline:")
  );
}

export async function continueApplication(input: {
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
  await resumeApplicationHook(run.id, {
    action: "continue",
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
  if (run.browserSessionId && (input.answers || input.otp)) {
    return runApplicationUntilPause({
      applyUrl,
      company: run.company,
      executionId: run.id,
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
  if (run.workflowRunId && !run.workflowRunId.startsWith("inline:")) {
    try {
      const workflowApi = await import("workflow/api");
      await workflowApi.getRun(run.workflowRunId).cancel();
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
