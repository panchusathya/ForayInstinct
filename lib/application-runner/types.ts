import type { AccessScope } from "@/lib/access-scope";
import {
  alreadyInProgressStatus,
  type ApplicationPauseReason,
  workerBlockerPrefix,
} from "@/lib/task-completion";

export const applicationRunnerModel = "application-runner";

/**
 * A start refused because the stored profile cannot answer the form. Distinct
 * from `waiting` on purpose: every instruction for a `user_input` pause tells
 * the agent to call `continue_application`, which would throw here because no
 * run exists to continue. The pause kind stays `user_input` so the channel
 * still classifies it as an ordinary non-approval pause.
 */
export const needsProfileStatus = "needs_profile";

export type { ApplicationPauseReason } from "@/lib/task-completion";

export interface ApplicationRunInput {
  applyUrl: string;
  company: string;
  executionId: string;
  /** The candidate's answers keyed by the question label the runner asked. */
  resumeAnswered?: Record<string, string>;
  /** Free-text answers with no question attached; only the helper reads them. */
  resumeAnswers?: string;
  /** A verification code the page asked for after the submit. */
  resumeOtp?: string;
  role: string;
  rootSessionId: string;
  scope: AccessScope;
}

/**
 * One question the page still needs answered, as the runner will recognize it
 * again: the exact label, and the choices the control offers when it is a
 * closed set. The coordinator asks these all at once and hands the answers
 * back keyed by `label`.
 */
export interface RunnerQuestion {
  label: string;
  options?: string[];
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
      message: string;
      missing: string[];
      pause: "user_input";
      status: typeof needsProfileStatus;
    }
  | {
      applyUrl: string;
      executionId: string;
      message: string;
      pause: ApplicationPauseReason;
      questions?: RunnerQuestion[];
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

/**
 * Execution statuses that still own their posting. Everything else — completed,
 * failed, timed_out — is terminal and must not block a fresh start.
 */
export const liveRunStatuses: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting",
]);

/** The durable run id to address through `workflow/api`, or nothing inline. */
export function durableWorkflowRunId(
  workflowRunId: string | null | undefined
): string | undefined {
  return isInlineWorkflow(workflowRunId)
    ? undefined
    : (workflowRunId ?? undefined);
}

/**
 * Whether a candidate's reply reads as a verification code: four to sixteen
 * letters, digits, spaces or dashes with at least one digit. "Yes" and
 * "None" are not; "482 913" and "7K3-9D2" are.
 */
export function looksLikeVerificationCode(value: string) {
  const trimmed = value.trim();
  return (
    /^[A-Za-z0-9][A-Za-z0-9 -]{2,14}[A-Za-z0-9]$/u.test(trimmed) &&
    /\d/u.test(trimmed)
  );
}

export function alreadyInProgressMessage(applyUrl: string) {
  return `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another run is already handling ${applyUrl}.`;
}

export function applicationCallId(applyUrl: string) {
  return `apply:${applyUrl}`;
}
