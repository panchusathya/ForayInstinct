import { inspectPostActionBrowserState } from "@/agent/subagents/worker/lib/post-action-browser-state";
import { recordSubmissionReviewEvidence } from "@/agent/subagents/worker/lib/browser-run-evidence";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
  saveCandidateProfile,
} from "@/db/services/candidate-profile";
import { readOrImportDefaultResume } from "@/db/services/default-resume";
import { readSelfIdentification } from "@/db/services/self-identification";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import { updateApplicationRun } from "@/db/services/application-executions";
import { applicationExecutionLog } from "@/lib/application-execution";
import { browserProvider } from "@/lib/browser";
import { suggestUnmappedFills } from "@/lib/application-runner/ambiguous";
import {
  fillForAnswer,
  type MappedFill,
  mapProfileToFormFields,
  matchFieldByLabel,
  profilePatchForAnswer,
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import {
  applyFillsCode,
  clickSubmitCode,
  collectEmptyRequiredFieldsCode,
  collectVisibleFieldsCode,
  detectLoginWallCode,
  setFileInputCode,
} from "@/lib/application-runner/playwright-scripts";
import { tryFillLoginFromVault } from "@/lib/application-runner/vault";
import type {
  ApplicationPauseReason,
  ApplicationRunInput,
  RunnerQuestion,
} from "@/lib/application-runner/types";
import {
  type CandidateProfile,
  candidateProfileSummary,
  profilePatchOf,
} from "@/lib/candidate-profile";
import { applicationPauseMessage } from "@/lib/task-completion";
import { z } from "zod";

export type FillStepResult =
  | {
      applyUrl: string;
      pause: ApplicationPauseReason;
      message: string;
      questions?: RunnerQuestion[];
    }
  | { applyUrl: string; done: true; message: string }
  | { continue: true };

const visibleFieldSchema = z.object({
  label: z.string(),
  name: z.string(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  selector: z.string(),
  tag: z.string(),
  type: z.string(),
});

const emptyRequiredSchema = z.object({
  empty: z.array(
    z.object({
      label: z.string(),
      nearby: z.string().default(""),
      selector: z.string(),
      tag: z.string().default(""),
    })
  ),
});

/**
 * Whether a field carries wording a candidate could actually answer.
 *
 * A control with no label leaves the helper nothing to name, and it answered
 * with the only string it had — our own CSS selector — which then reached the
 * candidate as the question. Neither the helper nor the candidate should ever
 * be handed one of these.
 */
function hasReadableLabel(label: string) {
  const text = label.replace(/\s+/gu, " ").trim();
  if (text.length < 2) return false;
  return !/^[#.(]|\[name=|\)\[\d+\]$/u.test(text);
}

/**
 * Applies fills and reports what the page refused.
 *
 * The script's report used to be discarded, which is how a form could be
 * offered for approval with a required question still blank: nothing ever
 * compared what was asked for against what took. `refused` is the controls
 * that matched none of the phrasings offered, each with the choices the page
 * really has, so the question can go back to the candidate in the page's own
 * words instead of ours.
 */
async function applyFills(sessionId: string, fills: MappedFill[]) {
  if (fills.length === 0) return { refused: [], skipped: [] };
  const applied = await parseResult(
    sessionId,
    applyFillsCode(fills),
    z.object({
      filled: z.array(z.string()),
      offered: z
        .array(z.object({ options: z.array(z.string()), selector: z.string() }))
        .default([]),
      skipped: z.array(z.object({ reason: z.string(), selector: z.string() })),
    })
  );
  const offered = new Map(
    (applied?.offered ?? []).map((row) => [row.selector, row.options] as const)
  );
  for (const control of applied?.offered ?? []) {
    applicationExecutionLog({
      event: "runner.option_mismatch",
      options: control.options.slice(0, 12).join(" | "),
      selector: control.selector,
    });
  }
  const skipped = applied?.skipped ?? [];
  for (const row of skipped) {
    if (row.reason === "no-option") continue;
    // A fill the page threw on was invisible: neither filled nor refused, it
    // left a control blank with nothing in the log to say so. The reason is
    // the browser's own error text, never the value that was being placed.
    applicationExecutionLog({
      event: "runner.fill_skipped",
      reason: row.reason.slice(0, 200),
      selector: row.selector,
    });
  }
  return {
    refused: skipped
      .filter((row) => row.reason === "no-option")
      .map((row) => ({
        options: offered.get(row.selector) ?? [],
        selector: row.selector,
      })),
    skipped,
  };
}

/**
 * Writes what the helper placed back onto the profile, without overwriting.
 *
 * Without this an answer lives only for the one pass it was given in: the next
 * round re-derives every value from the stored profile, finds the same gap,
 * and asks the same question again. That is the loop a candidate experiences
 * as the runner ignoring them.
 *
 * Only fills the deterministic mapper could not place are considered, only
 * fields `profilePatchForAnswer` recognizes are kept, and a value already on
 * the profile is never overwritten — a helper's fill is weaker evidence than
 * something the candidate entered deliberately.
 */
async function rememberAnswers(input: {
  fields: VisibleFormField[];
  fills: MappedFill[];
  profile: CandidateProfile;
  scope: ApplicationRunInput["scope"];
}) {
  const bySelector = new Map(
    input.fields.map((field) => [field.selector, field] as const)
  );
  const current: Record<string, unknown> = { ...input.profile };
  const patch: Record<string, unknown> = {};
  for (const fill of input.fills) {
    const field = bySelector.get(fill.selector);
    if (!field) continue;
    const candidate = profilePatchForAnswer(field, fill.value, input.profile);
    if (!candidate) continue;
    for (const [key, value] of Object.entries(candidate)) {
      const existing = current[key];
      const alreadySet =
        typeof existing === "string"
          ? existing.trim() !== ""
          : existing !== null;
      if (alreadySet) continue;
      patch[key] = value;
    }
  }
  const stated = profilePatchOf(patch);
  if (!stated) return;
  // A profile write must never take down an in-flight application.
  await saveCandidateProfile(input.scope, stated).catch(() => undefined);
}

/**
 * The candidate's own answers, keyed by the question the runner asked.
 *
 * This is the deterministic path an answer takes: the label finds the control
 * on the fresh scan, the answer becomes a fill with every phrasing that means
 * the same thing, and the fact it states goes onto the profile — overwriting,
 * because the candidate just answered this exact question. No model sees it.
 * An answer whose question is not on the page any more goes to the helper as
 * plain text rather than being dropped.
 */
function answeredFills(
  fields: VisibleFormField[],
  answered: Record<string, string>,
  profile: CandidateProfile
) {
  const fills: MappedFill[] = [];
  const leftover: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [question, answer] of Object.entries(answered)) {
    const value = answer.trim();
    if (value === "") continue;
    const field = matchFieldByLabel(fields, question);
    const fill = field ? fillForAnswer(field, value) : undefined;
    if (!field || !fill) {
      leftover.push(`${question}: ${value}`);
      continue;
    }
    fills.push(fill);
    Object.assign(patch, profilePatchForAnswer(field, value, profile) ?? {});
  }
  return { fills, leftover, patch };
}

/** Candidate-facing text for one question, with the page's choices if any. */
function describeQuestion(question: RunnerQuestion) {
  const options = question.options?.filter(Boolean).slice(0, 8) ?? [];
  return options.length > 0
    ? `${question.label} (${options.join(" / ")})`
    : question.label;
}

function tidyLabel(label: string) {
  return label.replace(/\s+/gu, " ").trim();
}

/**
 * The page's own account of what is still blank, as a pause when anything is.
 *
 * A control the mapper never saw, or a value the page would not accept, is
 * invisible upstream, so this is the one check standing between an incomplete
 * form and a submit. It runs before the approval gate and again immediately
 * before the click, because between the two the candidate answers questions
 * and a form can come back still short.
 */
async function blankRequiredPause(
  input: ApplicationRunInput & {
    browserSessionId: string;
    knownOptions?: (selector: string) => string[];
  }
): Promise<FillStepResult | undefined> {
  const remaining = await parseResult(
    input.browserSessionId,
    collectEmptyRequiredFieldsCode,
    emptyRequiredSchema
  );
  const stillEmpty = remaining?.empty ?? [];
  if (stillEmpty.length === 0) return undefined;
  const questions: RunnerQuestion[] = [];
  const labels = new Set<string>();
  for (const field of stillEmpty) {
    if (!hasReadableLabel(field.label)) continue;
    const label = tidyLabel(field.label);
    const key = label.toLowerCase();
    if (labels.has(key)) continue;
    labels.add(key);
    const options = input.knownOptions?.(field.selector) ?? [];
    questions.push(options.length > 0 ? { label, options } : { label });
  }
  const unreadable = stillEmpty.filter(
    (field) => !hasReadableLabel(field.label)
  );
  for (const field of unreadable) {
    // The selector alone says nothing. Record the shape and the surrounding
    // form wording so an unreadable control can be identified from the logs.
    applicationExecutionLog({
      apply_url: input.applyUrl,
      event: "runner.unlabelled_field",
      execution_id: input.executionId,
      nearby: field.nearby,
      selector: field.selector,
      tag: field.tag,
    });
  }
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: "user_input",
    status: "waiting",
  });
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage(
      "user_input",
      [
        questions.length > 0
          ? `these required questions are still blank: ${questions.map(describeQuestion).join("; ")}`
          : "",
        unreadable.length > 0
          ? `${String(unreadable.length)} required ${unreadable.length === 1 ? "field carries" : "fields carry"} no label I can read, so I cannot say what ${unreadable.length === 1 ? "it is" : "they are"} asking`
          : "",
      ]
        .filter(Boolean)
        .join("; ") + "."
    ),
    pause: "user_input",
    ...(questions.length > 0 ? { questions } : {}),
  };
}

export async function fillVisibleForm(
  input: ApplicationRunInput & {
    browserSessionId: string;
    answered?: Record<string, string>;
    answers?: string;
  }
): Promise<FillStepResult> {
  const login = await parseResult(
    input.browserSessionId,
    detectLoginWallCode,
    z.object({ loginWall: z.boolean() })
  );
  if (login?.loginWall) {
    const vault = await tryFillLoginFromVault({
      browserSessionId: input.browserSessionId,
      scope: input.scope,
    }).catch(() => ({ filled: false, origin: input.applyUrl }));
    if (!vault.filled) {
      return {
        applyUrl: input.applyUrl,
        message: applicationPauseMessage(
          "vault_setup",
          `sign-in is required for ${input.applyUrl}.`
        ),
        pause: "vault_setup",
      };
    }
  }
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  if (probe?.emailOtp) {
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "email_otp",
        probe.otpHint ?? input.applyUrl
      ),
      pause: "email_otp",
    };
  }
  if (probe?.smsOtp) {
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        "SMS verification is required."
      ),
      pause: "user_input",
    };
  }
  const collected = await parseResult(
    input.browserSessionId,
    collectVisibleFieldsCode,
    z.object({ fields: z.array(visibleFieldSchema) })
  );
  const fields: VisibleFormField[] = collected?.fields ?? [];
  const bySelector = new Map(
    fields.map((field) => [field.selector, field] as const)
  );
  const [profile, identity, selfIdentification] = await Promise.all([
    readCandidateProfile(input.scope),
    readCandidateContactIdentity(input.scope),
    // Voluntary EEO answers. Unset ones are declined on the form rather than
    // asked about, which is what these questions offer a decline option for.
    readSelfIdentification(input.scope).catch(() => ({})),
  ]);
  const resume = await stageResume(input).catch(() => undefined);
  const mapped = mapProfileToFormFields({
    fields,
    identity,
    profile,
    resumePath: resume?.path,
    selfIdentification,
  });

  // The candidate's answers first. They outrank the profile for the control
  // they name — the profile's value is what the page just refused — and they
  // are kept, so the same question is never asked on the next posting.
  const answered = answeredFills(fields, input.answered ?? {}, profile);
  const answeredSelectors = new Set(
    answered.fills.map((fill) => fill.selector)
  );
  const statedByCandidate = profilePatchOf(answered.patch);
  if (statedByCandidate) {
    await saveCandidateProfile(input.scope, statedByCandidate).catch(
      () => undefined
    );
  }

  const report = await applyFills(input.browserSessionId, [
    ...mapped.fills.filter(
      (fill) =>
        !fill.value.startsWith("/tmp/") && !answeredSelectors.has(fill.selector)
    ),
    ...answered.fills,
  ]);
  for (const fill of mapped.fills.filter((row) =>
    row.value.startsWith("/tmp/")
  )) {
    await browserProvider.executePlaywright(input.browserSessionId, {
      code: setFileInputCode(fill.selector, fill.value),
    });
  }

  // A control that refused every phrasing is a question again, now carrying
  // the choices the page really offers. Before, it vanished here: it was
  // neither unmapped nor filled, so nothing ever asked about it and the run
  // stalled on it round after round.
  const refusedOptions = new Map(
    report.refused.map((row) => [row.selector, row.options] as const)
  );
  const refused = report.refused.flatMap((row) => {
    const field = bySelector.get(row.selector);
    if (!field) return [];
    return [
      {
        ...field,
        options: row.options.length > 0 ? row.options : field.options,
      },
    ];
  });
  const seen = new Set<string>();
  // Only fields with wording worth showing a candidate. An unlabelled one has
  // no question for the helper to name, and its selector must never become one.
  const askable = [...mapped.unmapped, ...refused].filter((field) => {
    if (
      answeredSelectors.has(field.selector) &&
      !refusedOptions.has(field.selector)
    ) {
      return false;
    }
    if (seen.has(field.selector)) return false;
    seen.add(field.selector);
    return hasReadableLabel(field.label);
  });
  const helperAnswers = [input.answers, ...answered.leftover]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  if (askable.length > 0) {
    const helper = await suggestUnmappedFills({
      ...(helperAnswers ? { answers: helperAnswers } : {}),
      fields: askable,
      profileSummary: candidateProfileSummary(profile, identity).text,
    });
    if (helper.fills.length > 0) {
      await applyFills(input.browserSessionId, helper.fills);
      await rememberAnswers({
        fields: askable,
        fills: helper.fills,
        profile,
        scope: input.scope,
      });
    }
  }

  const blank = await blankRequiredPause({
    ...input,
    knownOptions: (selector) =>
      refusedOptions.get(selector) ?? bySelector.get(selector)?.options ?? [],
  });
  if (blank) return blank;
  await recordBrowserRunCheckpoint(input.scope, input.browserSessionId, {
    action: "fill",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "form",
    state: "completed",
  }).catch(() => undefined);
  return { continue: true };
}

export async function captureApproval(
  input: ApplicationRunInput & { browserSessionId: string }
): Promise<FillStepResult> {
  await recordSubmissionReviewEvidence(input.scope, input.browserSessionId, {
    applyUrl: input.applyUrl,
    role: input.role,
  });
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: "approval",
    status: "waiting",
  });
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage(
      "approval",
      `${input.role} ${input.applyUrl}`
    ),
    pause: "approval",
  };
}

/**
 * Clicks submit and only calls it done when the page agrees.
 *
 * An ATS refuses an incomplete form in place: the click lands, the URL never
 * changes, and nothing was sent. Marking that run completed told the candidate
 * their application was in when it was not, so an unconfirmed click now stays a
 * pause and carries the page's own complaint back.
 */
export async function submitApplication(
  input: ApplicationRunInput & { browserSessionId: string }
): Promise<FillStepResult> {
  // Never click submit on a form that is not finished. Approval used to go
  // straight here, so a run whose last pause named a blank required question
  // clicked anyway: the page refused it silently, nothing navigated, and the
  // candidate was told the application had not gone through with no reason
  // given. Asking the page first turns that into the question it always was.
  const blank = await blankRequiredPause(input);
  if (blank) return blank;
  const click = await parseResult(
    input.browserSessionId,
    clickSubmitCode,
    z.object({
      clicked: z.boolean(),
      errors: z.array(z.string()).default([]),
      invalid: z.array(z.string()).default([]),
      navigated: z.boolean().default(false),
    })
  );
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  const submitted = probe?.submitted === true;
  // The page's visible error text, and failing that the browser's own verdict
  // on each control. A form can refuse a submit with no message rendered at
  // all, which is how a blocked submit reported "errors: none".
  const complaint = [...(click?.errors ?? []), ...(click?.invalid ?? [])]
    .map((error) => error.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
  // The one question that matters most about a run — did the application
  // actually go in — was the only transition that wrote no log line. It was
  // answerable from a checkpoint row and nowhere else, so nobody reading the
  // logs, the candidate included, could tell a submitted application from a
  // refused one. The page's own words, never the candidate's values.
  applicationExecutionLog({
    apply_url: input.applyUrl,
    clicked: click?.clicked === true,
    errors: complaint.join(" | ") || "none",
    invalid: (click?.invalid ?? []).length,
    event: "runner.submit",
    execution_id: input.executionId,
    navigated: click?.navigated === true,
    status: submitted ? "completed" : "blocked",
    submitted,
  });
  await recordBrowserRunCheckpoint(input.scope, input.browserSessionId, {
    action: "submit",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "submit",
    state: submitted ? "submission_observed" : "blocked",
  }).catch(() => undefined);
  if (submitted) {
    await updateApplicationRun({
      executionId: input.executionId,
      pauseReason: null,
      status: "completed",
    });
    return {
      applyUrl: input.applyUrl,
      done: true,
      message: `Submitted ${input.role} at ${input.applyUrl}.`,
    };
  }
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: "user_input",
    status: "waiting",
  });
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage(
      "user_input",
      click?.clicked === false
        ? `no submit control was found on ${input.applyUrl}.`
        : complaint.length > 0
          ? `the submission was refused: ${complaint.join("; ")}.`
          : `the submit was clicked but ${input.applyUrl} never confirmed it. The application is not in.`
    ),
    pause: "user_input",
  };
}

async function stageResume(
  input: ApplicationRunInput & { browserSessionId: string }
) {
  const document = await readOrImportDefaultResume(input.scope);
  if (!document) return undefined;
  const filename = document.filename.replace(/[^\w.-]+/gu, "_");
  const path = `/tmp/goforay-default-resume-${filename}`;
  await browserProvider.stageFile(input.browserSessionId, {
    bytes: document.bytes,
    path,
  });
  return { path };
}

async function parseResult<T extends z.ZodType>(
  sessionId: string,
  code: string,
  schema: T
): Promise<z.infer<T> | undefined> {
  const response = await browserProvider.executePlaywright(sessionId, { code });
  const parsed = schema.safeParse(response.result);
  return parsed.success ? parsed.data : undefined;
}
