import { findApplicationRun } from "@/db/services/application-executions";
import { updateApplicationRun } from "@/db/services/application-executions";
import { applicationExecutionLog } from "@/lib/application-execution";
import { openApplicationBrowser } from "@/lib/application-runner/browser";
import {
  captureApproval,
  fillVisibleForm,
} from "@/lib/application-runner/fill";
import type { ApplicationRunInput } from "@/lib/application-runner/types";

export async function runApplicationUntilPause(input: ApplicationRunInput) {
  const existing = await findApplicationRun({
    applyUrl: input.applyUrl,
    scope: input.scope,
  });
  const existingSessionId = existing?.browserSessionId;
  const browser =
    typeof existingSessionId === "string" && existingSessionId !== ""
      ? { session_id: existingSessionId }
      : await openApplicationBrowser({
          applyUrl: input.applyUrl,
          executionId: input.executionId,
          scope: input.scope,
        });
  const filled = await fillVisibleForm({
    ...input,
    answers: input.resumeAnswers,
    browserSessionId: browser.session_id,
  });
  if ("pause" in filled) {
    await updateApplicationRun({
      browserSessionId: browser.session_id,
      executionId: input.executionId,
      pauseReason: filled.pause,
      status: "waiting",
    });
    applicationExecutionLog({
      apply_url: input.applyUrl,
      event: "runner.paused",
      execution_id: input.executionId,
      pause_reason: filled.pause,
      status: "waiting",
    });
    return filled;
  }
  return captureApproval({
    ...input,
    browserSessionId: browser.session_id,
  });
}
