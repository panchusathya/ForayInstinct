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
} from "@/lib/application-runner/types";
import { startApplicationWorkflow } from "@/lib/application-runner/workflow";

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
  const existing = await findApplicationRun({ applyUrl, scope: input.scope });
  if (
    existing?.workflowRunId !== undefined &&
    existing.workflowRunId !== null &&
    existing.workflowRunId !== ""
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
  await updateApplicationRun({
    executionId: id,
    status: "running",
    workflowRunId,
  });
  return {
    executionId: id,
    expiresAt: claim.expiresAt,
    message: `Application for ${input.role} is running.`,
    status: "working",
  };
}
