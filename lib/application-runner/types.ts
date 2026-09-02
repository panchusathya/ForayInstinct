import type { AccessScope } from "@/lib/access-scope";
import {
  alreadyInProgressStatus,
  workerBlockerPrefix,
} from "@/lib/task-completion";

export const applicationRunnerModel = "application-runner";

const applicationPauseReasons = [
  "approval",
  "email_otp",
  "user_input",
  "vault_setup",
  "posting_unavailable",
] as const;

export type ApplicationPauseReason = (typeof applicationPauseReasons)[number];

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
    };

export function alreadyInProgressMessage(applyUrl: string) {
  return `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another run is already handling ${applyUrl}.`;
}

export function applicationCallId(applyUrl: string) {
  return `apply:${applyUrl}`;
}
