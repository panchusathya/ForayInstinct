import type { AccessScope } from "@/lib/access-scope";
import {
  alreadyInProgressStatus,
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
    };

export function alreadyInProgressMessage(applyUrl: string) {
  return `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another run is already handling ${applyUrl}.`;
}

export function applicationCallId(applyUrl: string) {
  return `apply:${applyUrl}`;
}
