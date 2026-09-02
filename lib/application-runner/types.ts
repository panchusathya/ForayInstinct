import type { AccessScope } from "@/lib/access-scope";
import {
  alreadyInProgressStatus,
  type ApplicationPauseReason,
  workerBlockerPrefix,
} from "@/lib/task-completion";

export const applicationRunnerModel = "application-runner";

export type { ApplicationPauseReason } from "@/lib/task-completion";

export interface ApplicationRunInput {
  applyUrl: string;
  company: string;
  executionId: string;
  resumeAnswers?: string;
  role: string;
  rootSessionId: string;
  scope: AccessScope;
}

export type ApplicationRunResult =
  | {
      applyUrl: string;
      executionId: string;
      expiresAt: string;
      message: string;
      status: "working";
    }
  | {
      applyUrl: string;
      existingExecutionId: string;
      message: string;
      status: typeof alreadyInProgressStatus;
    }
  | {
      applyUrl: string;
      executionId: string;
      message: string;
      pause: ApplicationPauseReason;
      status: "waiting";
    }
  | {
      applyUrl: string;
      done: true;
      executionId: string;
      message: string;
      status: "completed";
    };

/**
 * A run the durable Workflow SDK never took ownership of, so the caller drives
 * each fill step itself. `startApplicationWorkflow` marks these with an
 * `inline:` prefix; a missing id predates the column and is treated the same.
 */
export function isInlineWorkflow(workflowRunId: string | null | undefined) {
  return (
    workflowRunId === undefined ||
    workflowRunId === null ||
    workflowRunId.startsWith("inline:")
  );
}

/** The durable run id to address through `workflow/api`, or nothing inline. */
export function durableWorkflowRunId(
  workflowRunId: string | null | undefined
): string | undefined {
  return isInlineWorkflow(workflowRunId)
    ? undefined
    : (workflowRunId ?? undefined);
}

export function alreadyInProgressMessage(applyUrl: string) {
  return `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another run is already handling ${applyUrl}.`;
}

export function applicationCallId(applyUrl: string) {
  return `apply:${applyUrl}`;
}
