import { findApplicationRun } from "@/db/services/application-executions";
import { updateApplicationRun } from "@/db/services/application-executions";
import { applicationExecutionLog } from "@/lib/application-execution";
import {
  closeApplicationBrowser,
  isApplicationBrowserAlive,
  openApplicationBrowser,
} from "@/lib/application-runner/browser";
import {
  captureApproval,
  enterVerificationCode,
  fillVisibleForm,
  submitApplication,
} from "@/lib/application-runner/fill";
import {
  clickControl,
  decideNextStep,
  type NextStep,
  type PageSummary,
  readPageSummary,
} from "@/lib/application-runner/navigate";
import type { ApplicationRunInput } from "@/lib/application-runner/types";
import { applicationPauseMessage } from "@/lib/task-completion";

/** A form over more pages than this is a loop, not an application. */
const maxFormPages = 12;

/** The pause for a page whose way forward the runner could not find. */
function stuckPause(
  input: ApplicationRunInput,
  summary: PageSummary | undefined,
  controls: string[]
) {
  const seen = controls.slice(0, 8).join(", ");
  const heading =
    summary?.heading === "" || summary === undefined
      ? "the page"
      : summary.heading;
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage(
      "user_input",
      `${heading} on ${input.applyUrl} is filled in, but no control on it moves the application on${seen ? ` (controls seen: ${seen})` : ""}. Tell me which button to press, or what is missing.`
    ),
    pause: "user_input" as const,
  };
}

export async function runApplicationUntilPause(input: ApplicationRunInput) {
  const existing = await findApplicationRun({
    applyUrl: input.applyUrl,
    scope: input.scope,
  });
  // Only this execution's own browser, and only while the backend still has
  // it. The newest row for the posting used to be adopted whatever execution
  // it belonged to and whether or not its browser was alive, and a fresh
  // browser was written to the row only on a pause, so one that crashed
  // first leaked.
  const existingSessionId =
    existing?.id === input.executionId ? existing.browserSessionId : undefined;
  const reusable =
    typeof existingSessionId === "string" &&
    existingSessionId !== "" &&
    (await isApplicationBrowserAlive(existingSessionId));
  const browser: { session_id: string } = reusable
    ? { session_id: existingSessionId }
    : await openApplicationBrowser({
        applyUrl: input.applyUrl,
        executionId: input.executionId,
        scope: input.scope,
      });
  if (!reusable) {
    await updateApplicationRun({
      browserSessionId: browser.session_id,
      executionId: input.executionId,
    });
  }
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
    // The form's site can refuse the browser: OpenAI's posting hands off to
    // Ashby, and the gateway's open of it came back "connection closed". That
    // threw straight out of start_application, so the run sat as "running"
    // with its lease held while the candidate was told the form was being
    // filled, until the watchdog timed it out twenty minutes later.
    try {
      const reopened = await openApplicationBrowser({
        applyUrl,
        executionId: input.executionId,
        scope: input.scope,
      });
      browser.session_id = reopened.session_id;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .split("\n")[0]
        ?.slice(0, 200);
      applicationExecutionLog({
        apply_url: input.applyUrl,
        error: reason ?? "unknown",
        event: "runner.reopen_failed",
        execution_id: input.executionId,
        to: applyUrl.slice(0, 300),
      });
      filled = {
        applyUrl: input.applyUrl,
        message: applicationPauseMessage(
          "user_input",
          `${input.applyUrl} hands applicants to ${applyUrl}, and the browser could not open that page (${reason ?? "no reason given"}). Nothing was filled. Try again in a little while, or start from ${applyUrl} directly.`
        ),
        pause: "user_input",
      };
    }
    if (!("pause" in filled)) {
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
  // A form can run over several pages. Each page is filled and checked like
  // the only one, then the page is asked how it moves on: code decides when
  // only one kind of forward control is there, the model when the page is
  // ambiguous, and code clicks and confirms the page changed. Approval comes
  // on the page whose control sends the application, so the candidate reviews
  // the whole thing once, at the end.
  let stalled = 0;
  let reachedSubmit = false;
  for (let page = 0; page < maxFormPages && !("pause" in filled); page += 1) {
    const summary = await readPageSummary(browser.session_id);
    const step: NextStep = summary
      ? await decideNextStep(summary)
      : { action: "stuck", controls: [], via: "heuristic" };
    if (step.action === "submit") {
      reachedSubmit = true;
      break;
    }
    if (step.action === "stuck") {
      filled = stuckPause(input, summary, step.controls);
      break;
    }
    const outcome = await clickControl(browser.session_id, step.control);
    const moved =
      outcome.clicked &&
      (outcome.navigated ||
        (outcome.heading !== "" && outcome.heading !== summary?.heading));
    applicationExecutionLog({
      apply_url: input.applyUrl,
      control: step.control.text,
      errors: outcome.errors.join(" | ") || "none",
      event: "runner.advance",
      execution_id: input.executionId,
      from: summary?.heading ?? "",
      moved,
      page: page + 1,
      to: outcome.heading,
      via: step.via,
    });
    if (!moved) {
      if (outcome.errors.length > 0) {
        // The page refused to move on and said why, in its own words. That
        // is a question for the candidate, not a reason to click again.
        filled = {
          applyUrl: input.applyUrl,
          message: applicationPauseMessage(
            "user_input",
            `${summary?.heading === "" || summary === undefined ? "the page" : summary.heading} would not continue: ${outcome.errors.join("; ")}.`
          ),
          pause: "user_input",
        };
        break;
      }
      stalled += 1;
      if (stalled >= 2) {
        filled = stuckPause(
          input,
          summary,
          summary?.controls.map((control) => control.text) ?? []
        );
        break;
      }
      continue;
    }
    stalled = 0;
    filled = await fillVisibleForm({
      ...input,
      answered: input.resumeAnswered,
      answers: input.resumeAnswers,
      applyUrl,
      browserSessionId: browser.session_id,
    });
    if ("redirect" in filled) {
      filled = stuckPause(input, summary, []);
    }
  }
  // Running out of pages is a loop, not a form ready to send. It used to fall
  // through to approval, showing the candidate page twelve as the review of a
  // submission the runner had never reached.
  if (!("pause" in filled) && !reachedSubmit) {
    filled = {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        `${input.applyUrl} ran through ${String(maxFormPages)} pages without reaching a control that submits the application, so the form may be looping. Tell me which page it should stop on, or whether to give up.`
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
