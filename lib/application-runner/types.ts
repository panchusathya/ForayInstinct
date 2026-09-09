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
  /** A start that threw. The run is over; the message says why in one line. */
  | {
      applyUrl: string;
      executionId: string;
      message: string;
      pause: "user_input";
      status: "failed";
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
 * The id `startApplication` records as the run's owner. Every fill runs inline:
 * the coordinator tool that starts it drives the form to its first pause inside
 * its own invocation, and `continue_application` drives each step after that.
 *
 * This is deliberate, not a fallback. The tools execute inside eve's Nitro
 * bundle, where eve aliases `workflow/api` to its own vendored Workflow SDK
 * runtime and applies the `"use workflow"` compiler only to its own execution
 * sources. A workflow function authored here therefore reaches `start()`
 * without the compiler's metadata and is rejected as an invalid workflow
 * function on every call, and eve's flow route on the deployment would not know
 * the workflow even if it were compiled. eve documents workflow primitives as
 * an internal detail that tools never touch. A durable fill would need its own
 * Next-owned entrypoint outside eve, which this project does not have.
 *
 * The `inline:` prefix stays for rows written before the durable attempt was
 * removed; nothing reads the prefix any more.
 */
export function inlineWorkflowRunId(executionId: string) {
  return `inline:${executionId}`;
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

/**
 * Whether a candidate's reply reads as a verification code: four to eight
 * digits, or two short groups of letters and digits, with at least one
 * digit. "482 913", "7K3-9D2" and "123456" are; "Yes", "10 years", "Level 3"
 * and "Boston MA 02110" are not. The looser rule this replaces read "5 years"
 * as a code and typed it into the dialog.
 */
export function looksLikeVerificationCode(value: string) {
  const trimmed = value.trim();
  return (
    /^(?:\d{3}[ -]?\d{3,5}|\d{4,8}|[A-Za-z0-9]{3,4}[ -]?[A-Za-z0-9]{3,4})$/u.test(
      trimmed
    ) && /\d/u.test(trimmed)
  );
}

export function alreadyInProgressMessage(applyUrl: string) {
  return `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another run is already handling ${applyUrl}.`;
}

export function applicationCallId(applyUrl: string) {
  return `apply:${applyUrl}`;
}
