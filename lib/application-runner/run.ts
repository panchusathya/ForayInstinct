import { findApplicationRun } from "@/db/services/application-executions";
import { updateApplicationRun } from "@/db/services/application-executions";
import { applicationExecutionLog } from "@/lib/application-execution";
import {
  closeApplicationBrowser,
  openApplicationBrowser,
} from "@/lib/application-runner/browser";
import {
  captureApproval,
  enterVerificationCode,
  fillVisibleForm,
  submitApplication,
} from "@/lib/application-runner/fill";
import type { ApplicationRunInput } from "@/lib/application-runner/types";
import { applicationPauseMessage } from "@/lib/task-completion";

export async function runApplicationUntilPause(input: ApplicationRunInput) {
  const existing = await findApplicationRun({
    applyUrl: input.applyUrl,
    scope: input.scope,
  });
  const existingSessionId = existing?.browserSessionId;
  const browser: { session_id: string } =
    typeof existingSessionId === "string" && existingSessionId !== ""
      ? { session_id: existingSessionId }
      : await openApplicationBrowser({
          applyUrl: input.applyUrl,
          executionId: input.executionId,
          scope: input.scope,
        });
  // A code arrives only after the candidate approved and the submit opened a
  // verification step, so it is entered where the page left off, never by
  // filling the form again: the fill's own probe would see the code dialog
  // and hand the same pause straight back. With the code taken and nothing
  // confirmed, the submit is what remains.
  if (input.resumeOtp) {
    const verified = await enterVerificationCode({
      ...input,
      browserSessionId: browser.session_id,
      code: input.resumeOtp,
    });
    // A code sent on its own, to a page no longer asking for one, means the
    // dialog was already passed: the submit is what remains. A code that came
    // as an ordinary answer, to a page not asking, was an ordinary answer
    // after all and goes to the form below.
    const codeOnly =
      !input.resumeAnswers &&
      Object.keys(input.resumeAnswered ?? {}).length === 0;
    if (verified || codeOnly) {
      const outcome =
        verified ??
        (await submitApplication({
          ...input,
          browserSessionId: browser.session_id,
        }));
      if ("pause" in outcome) {
        applicationExecutionLog({
          apply_url: input.applyUrl,
          detail: outcome.message.slice(0, 300),
          event: "runner.paused",
          execution_id: input.executionId,
          pause_reason: outcome.pause,
          status: "waiting",
        });
      }
      return outcome;
    }
  }
  let applyUrl = input.applyUrl;
  let filled = await fillVisibleForm({
    ...input,
    answered: input.resumeAnswered,
    answers: input.resumeAnswers,
    browserSessionId: browser.session_id,
  });
  if ("redirect" in filled) {
    // The posting hands applicants to another site. The browser is pinned to
    // one site and would die on the hop, so it is closed and a new one opened
    // where the form is; the run keeps its posting, the fill gets the form.
    applicationExecutionLog({
      apply_url: input.applyUrl,
      event: "runner.redirected",
      execution_id: input.executionId,
      to: filled.redirect.slice(0, 300),
    });
    await closeApplicationBrowser({
      scope: input.scope,
      sessionId: browser.session_id,
    });
    applyUrl = filled.redirect;
    const reopened = await openApplicationBrowser({
      applyUrl,
      executionId: input.executionId,
      scope: input.scope,
    });
    browser.session_id = reopened.session_id;
    await updateApplicationRun({
      browserSessionId: browser.session_id,
      executionId: input.executionId,
    });
    filled = await fillVisibleForm({
      ...input,
      answered: input.resumeAnswered,
      answers: input.resumeAnswers,
      applyUrl,
      browserSessionId: browser.session_id,
    });
  }
  if ("redirect" in filled) {
    // Twice is a chain, not a form. Say where it led and stop.
    filled = {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        `${input.applyUrl} sends applicants to ${applyUrl}, which sends them on again to ${filled.redirect}. Start the application from the page that carries the form.`
      ),
      pause: "user_input",
    };
  }
  if ("pause" in filled) {
    await updateApplicationRun({
      browserSessionId: browser.session_id,
      executionId: input.executionId,
      pauseReason: filled.pause,
      status: "waiting",
    });
    applicationExecutionLog({
      apply_url: input.applyUrl,
      // Every gate pauses with the same reason, so the message is the only way
      // to tell an unanswered question from a blocked submit when reading back.
      detail: filled.message.slice(0, 300),
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
