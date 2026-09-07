import {
  createApplicationExecution,
  findApplicationRun,
  updateApplicationRun,
} from "@/db/services/application-executions";
import { claimApplicationLease } from "@/db/services/application-leases";
import {
  applicationExecutionLog,
  executionId,
  safeApplyUrl,
} from "@/lib/application-execution";
import { alreadyInProgressStatus } from "@/lib/task-completion";
import {
  alreadyInProgressMessage,
  applicationCallId,
  applicationRunnerModel,
  type ApplicationRunInput,
  type ApplicationRunResult,
  isInlineWorkflow,
  liveRunStatuses,
  needsProfileStatus,
} from "@/lib/application-runner/types";
import {
  missingProfileFacts,
  profileGateMessage,
} from "@/lib/application-runner/profile-gate";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
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
  // Above both the execution row and the lease on purpose. Below the lease, the
  // retry this result asks for would come back already_in_progress for the next
  // twenty minutes; above both, a refused start leaves no rows at all.
  const missing = await missingProfileFacts(input.scope);
  if (missing.length > 0) {
    applicationExecutionLog({
      apply_url: applyUrl,
      event: "runner.profile_gate",
      missing: missing.join(", "),
      status: needsProfileStatus,
    });
    return {
      applyUrl,
      message: profileGateMessage(missing, input.role),
      missing,
      pause: "user_input",
      status: needsProfileStatus,
    };
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
  // usually already closed. Close it in case it has not been, so the browser
  // is not leaked until the backend's own timeout, then clear the run state
  // so the fill opens a fresh one instead of driving a dead session.
  if (existing?.browserSessionId) {
    await closeApplicationBrowser({
      scope: input.scope,
      sessionId: existing.browserSessionId,
    });
  }
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
  let outcome: Awaited<ReturnType<typeof runApplicationUntilPause>>;
  try {
    outcome = await runApplicationUntilPause(runInput);
  } catch (error) {
    // A run that threw is a run that ended. Left as "running" with its lease
    // held, the coordinator read the row and told the candidate the form was
    // being filled until the watchdog timed it out twenty minutes later.
    const reason = (error instanceof Error ? error.message : String(error))
      .split("\n")[0]
      ?.slice(0, 200);
    applicationExecutionLog({
      apply_url: applyUrl,
      error: reason ?? "unknown",
      event: "runner.failed",
      execution_id: id,
    });
    const run = await findApplicationRun({ applyUrl, scope: input.scope });
    if (run?.browserSessionId) {
      await closeApplicationBrowser({
        scope: input.scope,
        sessionId: run.browserSessionId,
      });
    }
    await updateApplicationRun({
      browserSessionId: "",
      executionId: id,
      pauseReason: null,
      status: "failed",
    });
    return {
      applyUrl,
      executionId: id,
      message: applicationPauseMessage(
        "user_input",
        `the application for ${input.role} could not be started: ${reason ?? "the runner gave no reason"}. Nothing was filled; send the posting again to retry.`
      ),
      pause: "user_input",
      status: "failed",
    };
  }
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
      ...(outcome.questions ? { questions: outcome.questions } : {}),
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
