import {
  createApplicationExecution,
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { claimApplicationLease } from "@/db/services/application-leases";
import { executionId, safeApplyUrl } from "@/lib/application-execution";
import { alreadyInProgressStatus } from "@/lib/task-completion";
import {
  alreadyInProgressMessage,
  applicationCallId,
  applicationRunnerModel,
  type ApplicationRunInput,
  type ApplicationRunResult,
  isInlineWorkflow,
  liveRunStatuses,
} from "@/lib/application-runner/types";
import { runApplicationUntilPause } from "@/lib/application-runner/run";
import { startApplicationWorkflow } from "@/lib/application-runner/workflow";
import { applicationPauseMessage } from "@/lib/task-completion";

export async function startApplication(input: {
  applyUrl: string;
  company: string;
  role: string;
  rootSessionId: string;
  scope: ApplicationRunInput["scope"];
}): Promise<ApplicationRunResult> {
  const applyUrl = safeApplyUrl(input.applyUrl);
  if (applyUrl === "") {
    throw new Error("Application runner requires a posting apply_url.");
  }
  const callId = applicationCallId(applyUrl);
  const id = executionId(input.rootSessionId, callId);
  await createApplicationExecution({
    callId,
    identity: {
      applyUrl,
      company: input.company,
      role: input.role,
    },
    model: applicationRunnerModel,
    rootSessionId: input.rootSessionId,
    scope: input.scope,
  });
  const claim = await claimApplicationLease({
    applyUrl,
    executionId: id,
    rootSessionId: input.rootSessionId,
    scope: input.scope,
  });
  if (claim.status === "already_in_progress") {
    return {
      applyUrl,
      existingExecutionId: claim.existingExecutionId,
      message: alreadyInProgressMessage(applyUrl),
      status: alreadyInProgressStatus,
    };
  }
  // Refuse a duplicate dispatch only while a run is genuinely live. A finished
  // one keeps its workflow id forever, and the execution row is reused whenever
  // the same session retries the same posting, so matching on the id alone
  // would make one timed-out run block that posting for good.
  const existing = await findApplicationRun({ applyUrl, scope: input.scope });
  if (
    existing?.workflowRunId !== undefined &&
    existing.workflowRunId !== null &&
    existing.workflowRunId !== "" &&
    liveRunStatuses.has(existing.status)
  ) {
    return {
      applyUrl,
      existingExecutionId: existing.id,
      message: alreadyInProgressMessage(applyUrl),
      status: alreadyInProgressStatus,
    };
  }
  const runInput: ApplicationRunInput = {
    applyUrl,
    company: input.company,
    executionId: id,
    role: input.role,
    rootSessionId: input.rootSessionId,
    scope: input.scope,
  };
  const workflowRunId = await startApplicationWorkflow(runInput);
  // A retry reuses the execution row, whose browser session the watchdog has
  // already closed. Clear the run state so the fill opens a fresh one instead
  // of driving a dead session.
  await updateApplicationRun({
    browserSessionId: "",
    executionId: id,
    pauseReason: null,
    status: "running",
    workflowRunId,
  });
  if (!isInlineWorkflow(workflowRunId)) {
    return {
      applyUrl,
      executionId: id,
      expiresAt: claim.expiresAt,
      message: `Application for ${input.role} is running.`,
      status: "working",
    };
  }
  // Without a durable run nothing else will ever drive this execution, so the
  // fill has to finish inside the caller's own invocation. It stops at the
  // first pause, which continue_application resumes.
  const outcome = await runApplicationUntilPause(runInput);
  if ("done" in outcome) {
    return {
      applyUrl,
      done: true,
      executionId: id,
      message: outcome.message,
      status: "completed",
    };
  }
  if ("pause" in outcome) {
    return {
      applyUrl,
      executionId: id,
      message: outcome.message,
      pause: outcome.pause,
      status: "waiting",
    };
  }
  // `fillVisibleForm` only reports `continue` to its own caller, which turns it
  // into an approval pause. Treat an unexpected one as needing a human.
  return {
    applyUrl,
    executionId: id,
    message: applicationPauseMessage("user_input", applyUrl),
    pause: "user_input",
    status: "waiting",
  };
}
