import { inspectPostActionBrowserState } from "@/agent/subagents/worker/lib/post-action-browser-state";
import {
  recordSubmissionConfirmationEvidence,
  recordSubmissionReviewEvidence,
} from "@/agent/subagents/worker/lib/browser-run-evidence";
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
import {
  forgetRunAnswers,
  readRunAnswers,
  rememberRunAnswers,
} from "@/lib/manager/server/application-answers";
import { rememberContactPhone } from "@/lib/manager/server/contact-phone";
import { suggestUnmappedFills } from "@/lib/application-runner/ambiguous";
import {
  fillForAnswer,
  isPhoneField,
  type MappedFill,
  mapProfileToFormFields,
  matchFieldByLabel,
  phoneRenderings,
  profilePatchForAnswer,
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import {
  applyFillsCode,
  clickSubmitCode,
  collectEmptyRequiredFieldsCode,
  collectVisibleFieldsCode,
  attachFileCode,
  detectLoginWallCode,
  enterVerificationCodeCode,
  reachApplicationFormCode,
  verificationCodeProbeCode,
} from "@/lib/application-runner/playwright-scripts";
import {
  loginWallSchema,
  passLoginWall,
} from "@/lib/application-runner/account";
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
  /** The posting hands applicants to another site; the run must reopen there. */
  | { applyUrl: string; redirect: string }
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

/**
 * Whether a scan found a form worth filling: two or more controls a candidate
 * would type or choose in, a file slot, or a control the page marks required.
 * One lone optional input is a search box or a newsletter field on a
 * description page, not an application.
 */
function looksLikeApplicationForm(fields: VisibleFormField[]) {
  const fillable = fields.filter(
    (field) => field.tag !== "checkbox" && field.tag !== "radio"
  );
  return (
    fillable.length >= 2 ||
    fillable.some((field) => field.tag === "file" || field.required)
  );
}

/**
 * What to call a file slot when asking for it. The page's label when it has
 * one a candidate could read; failing that, a resume slot is called Resume
 * rather than dropped, because the one file control a form almost always has
 * is the one a candidate has to be told about.
 */
function fileQuestionLabel(field: VisibleFormField) {
  const label = fileSlotName(field.label);
  if (hasReadableLabel(label)) return label;
  return /resume|\bcv\b|curriculum/iu.test(field.name + field.selector)
    ? "Resume/CV"
    : "";
}

/**
 * A file input is often labelled by the button that opens it, so its label
 * reads Attach or Upload: a verb, not a question. Told "could not be attached
 * to Attach", nobody knows which control was meant. A bare verb is replaced
 * by what the slot is for.
 */
function fileSlotName(label: string) {
  const tidy = tidyLabel(label);
  if (
    tidy === "" ||
    /^(?:attach|upload|browse|add|choose|select)(?: an?)?(?: file| files| document)?\W*$/iu.test(
      tidy
    )
  ) {
    return "Resume/CV";
  }
  return tidy;
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
    /** File controls the workspace has nothing for, by label. */
    missingFiles?: string[];
    /** Whether those are empty because no resume is on file at all. */
    noResume?: boolean;
  }
): Promise<FillStepResult | undefined> {
  const remaining = await parseResult(
    input.browserSessionId,
    collectEmptyRequiredFieldsCode,
    emptyRequiredSchema,
    "blank_required"
  );
  const stillEmpty = remaining?.empty ?? [];
  const missingFiles = input.missingFiles ?? [];
  if (stillEmpty.length === 0 && missingFiles.length === 0) return undefined;
  const questions: RunnerQuestion[] = [];
  const labels = new Set<string>();
  // The file slots first: a page rarely marks its upload control required in
  // the DOM, so the scan below would not list them, and a form without its
  // resume is exactly the incomplete form this pause exists to catch.
  for (const label of missingFiles) {
    const key = label.toLowerCase();
    if (labels.has(key)) continue;
    labels.add(key);
    questions.push({ label });
  }
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
  if (unreadable.length > 0) {
    // Seven unlabelled required text inputs on Greenhouse were its code
    // boxes. A page asking for a code is a verification pause, never a list
    // of fields nobody can name.
    const asked = await verificationAsked(input.browserSessionId, undefined);
    if (asked) return verificationPause(input, asked);
  }
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
        missingFiles.length > 0 && input.noResume
          ? `no resume is on file, so ${missingFiles.join("; ")} cannot be filled until a PDF or DOCX resume is attached`
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
    loginWallSchema,
    "login_wall"
  );
  if (login?.loginWall) {
    // Sign in with a saved login, or register with the candidate's email and
    // a generated password the vault keeps; only a page with neither path
    // pauses for vault setup.
    const passed = await passLoginWall({
      applyUrl: input.applyUrl,
      browserSessionId: input.browserSessionId,
      executionId: input.executionId,
      scope: input.scope,
      wall: login,
    });
    if ("pause" in passed) return passed;
  }
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  // A page asking for a verification code is not a form to fill. The code
  // arrives through the run's continue and is entered before this runs; with
  // none in hand, the pause names the step so the agent goes to Gmail first
  // and the candidate second.
  const asked = await verificationAsked(input.browserSessionId, probe);
  if (asked) return verificationPause(input, asked);
  const collected = await parseResult(
    input.browserSessionId,
    collectVisibleFieldsCode,
    z.object({ fields: z.array(visibleFieldSchema) }),
    "collect_fields"
  );
  let fields: VisibleFormField[] = collected?.fields ?? [];
  // A posting URL often lands on the description, with the form one click
  // away. A page with nothing to fill is not a filled form: it used to go to
  // the candidate for approval as one, the job description as the review.
  if (!looksLikeApplicationForm(fields)) {
    const reach = await parseResult(
      input.browserSessionId,
      reachApplicationFormCode,
      z.object({
        clicked: z.string().default(""),
        controls: z.number().optional(),
        external: z.string().optional(),
        fields: z.number().default(0),
        form: z.boolean(),
        href: z.string().optional(),
      }),
      "reach_form"
    );
    applicationExecutionLog({
      apply_url: input.applyUrl,
      clicked: reach?.clicked ?? "",
      event: "runner.reach_form",
      execution_id: input.executionId,
      external: reach?.external !== undefined,
      fields: reach?.fields ?? 0,
      form: reach?.form === true,
    });
    if (reach?.external) {
      return { applyUrl: input.applyUrl, redirect: reach.external };
    }
    if (reach?.form) {
      const again = await parseResult(
        input.browserSessionId,
        collectVisibleFieldsCode,
        z.object({ fields: z.array(visibleFieldSchema) }),
        "collect_fields"
      );
      fields = again?.fields ?? [];
    }
    if (!looksLikeApplicationForm(fields)) {
      await updateApplicationRun({
        executionId: input.executionId,
        pauseReason: "user_input",
        status: "waiting",
      });
      return {
        applyUrl: input.applyUrl,
        message: applicationPauseMessage(
          "user_input",
          `no application form was found at ${input.applyUrl}: the page has nothing to fill${reach?.clicked ? ` even after opening "${reach.clicked}"` : " and no Apply control"}. If the posting links to an application elsewhere, that link is the URL to start with.`
        ),
        pause: "user_input",
      };
    }
  }
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
  const resume = await stageResume(input);
  const mapped = mapProfileToFormFields({
    fields,
    identity,
    profile,
    resumePath: resume?.path,
    selfIdentification,
  });
  // A file control nothing can fill is a question for the candidate, never
  // for the helper: a model cannot produce a file, and the fill script skips
  // file inputs anyway, so one routed there was silently dropped and the form
  // reached submit without its resume. It is asked below with everything else
  // still blank, in the page's words, whether or not the page marks it required.
  const missingFiles = mapped.unmapped
    .filter((field) => field.tag === "file")
    .map((field) => fileQuestionLabel(field))
    .filter((label) => label !== "");

  // The candidate's answers first. They outrank the profile for the control
  // they name — the profile's value is what the page just refused — and they
  // are kept, so the same question is never asked on the next posting.
  // Everything the candidate has answered on this run so far, so a form
  // filled again in a fresh browser after the last one died does not ask the
  // same questions over. This round's answers win over remembered ones.
  const remembered = await readRunAnswers(input.scope, input.executionId).catch(
    () => ({})
  );
  const thisRound = input.answered ?? {};
  if (Object.keys(thisRound).length > 0) {
    await rememberRunAnswers(input.scope, input.executionId, thisRound).catch(
      () => undefined
    );
  }
  const answered = answeredFills(
    fields,
    { ...remembered, ...thisRound },
    profile
  );
  // A phone number is identity, not profile, so profilePatchForAnswer leaves
  // it alone. Kept here instead, so it is never asked for twice.
  for (const [question, value] of Object.entries(thisRound)) {
    const field = matchFieldByLabel(fields, question);
    if (field && isPhoneField(field)) {
      await rememberContactPhone(input.scope, value).catch(() => undefined);
    }
  }
  const answeredSelectors = new Set(
    answered.fills.map((fill) => fill.selector)
  );
  const statedByCandidate = profilePatchOf(answered.patch);
  if (statedByCandidate) {
    await saveCandidateProfile(input.scope, statedByCandidate).catch(
      () => undefined
    );
  }

  const fileFills = mapped.fills.filter((row) => row.value === resume?.path);
  const report = await applyFills(input.browserSessionId, [
    ...mapped.fills.filter(
      (fill) =>
        !fileFills.includes(fill) && !answeredSelectors.has(fill.selector)
    ),
    ...answered.fills,
  ]);
  if (resume) {
    const attached = await attachResume(input, resume, fileFills, bySelector);
    if (attached) return attached;
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
    if (field.tag === "file") return false;
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
    missingFiles,
    noResume: resume === undefined,
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
  let outcome = await clickAndRead(input);
  // A submit refused for the phone number's shape is retried in the next
  // shape before anyone is told. The DoorDash form took a number typed by hand
  // and refused the same number stored as +1 and ten digits: "Please enter a
  // valid phone." The shapes come from the number on file, never the log.
  if (
    !outcome.submitted &&
    !outcome.verification &&
    outcome.complaint.some((line) => /phone|telephone|mobile/iu.test(line))
  ) {
    const phone = await readCandidateContactIdentity(input.scope).then(
      (identity) => identity.phone,
      () => undefined
    );
    const [tried, ...remaining] = phone ? phoneRenderings(phone) : [];
    if (tried !== undefined && remaining.length > 0) {
      const collected = await parseResult(
        input.browserSessionId,
        collectVisibleFieldsCode,
        z.object({ fields: z.array(visibleFieldSchema) }),
        "collect_fields"
      );
      const phoneFields = (collected?.fields ?? []).filter((field) =>
        isPhoneField(field)
      );
      for (const rendering of remaining) {
        if (phoneFields.length === 0) break;
        applicationExecutionLog({
          event: "runner.phone_retry",
          execution_id: input.executionId,
          rendering: phoneRenderingName(rendering),
        });
        await applyFills(
          input.browserSessionId,
          phoneFields.map((field) => ({
            selector: field.selector,
            value: rendering,
          }))
        );
        outcome = await clickAndRead(input);
        if (
          outcome.submitted ||
          outcome.verification ||
          !outcome.complaint.some((line) =>
            /phone|telephone|mobile/iu.test(line)
          )
        ) {
          break;
        }
      }
    }
  }
  const { click, complaint, submitted, verification } = outcome;
  await recordBrowserRunCheckpoint(input.scope, input.browserSessionId, {
    action: "submit",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "submit",
    state: submitted ? "submission_observed" : "blocked",
  }).catch(() => undefined);
  if (submitted) return completeSubmission(input);
  if (verification) return verificationPause(input, verification);
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

/** The shape of a phone rendering, for the log; never the number. */
function phoneRenderingName(rendering: string) {
  if (rendering.startsWith("+")) return "e164";
  if (rendering.includes("(")) return "formatted";
  return "digits";
}

/**
 * Clicks submit once and reads what the page did: confirmed, asking for a
 * verification code, or refusing, and in the page's own words. Logged every
 * time, because whether the application went in is the one fact about a run
 * that must never have to be inferred.
 */
async function clickAndRead(
  input: ApplicationRunInput & { browserSessionId: string }
) {
  const click = await parseResult(
    input.browserSessionId,
    clickSubmitCode,
    z.object({
      clicked: z.boolean(),
      errors: z.array(z.string()).default([]),
      invalid: z.array(z.string()).default([]),
      navigated: z.boolean().default(false),
    }),
    "click_submit"
  );
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  const submitted = probe?.submitted === true;
  // A submit that opens a verification step is neither in nor refused. The
  // DoorDash click came back "clicked, no navigation, no errors, not
  // submitted" and was reported as a failed submit, when Greenhouse had put up
  // its emailed-code dialog. That is a pause the agent knows how to resolve,
  // from Gmail first and the candidate second, so it has to be named as one.
  const verification = submitted
    ? undefined
    : await verificationAsked(input.browserSessionId, probe);
  // The page's visible error text, and failing that the browser's own verdict
  // on each control. A form can refuse a submit with no message rendered at
  // all, which is how a blocked submit reported "errors: none".
  const complaint = [...(click?.errors ?? []), ...(click?.invalid ?? [])]
    .map((error) => error.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
  applicationExecutionLog({
    apply_url: input.applyUrl,
    clicked: click?.clicked === true,
    errors: complaint.join(" | ") || "none",
    invalid: (click?.invalid ?? []).length,
    event: "runner.submit",
    execution_id: input.executionId,
    navigated: click?.navigated === true,
    status: submitted
      ? "completed"
      : verification
        ? `verification_${verification.channel}`
        : "blocked",
    submitted,
  });
  return { click, complaint, submitted, verification };
}

const verificationProbeSchema = z.object({
  boxes: z.boolean().optional(),
  channel: z.enum(["email", "sms"]).optional(),
  count: z.number().optional(),
  hint: z.string().optional(),
  present: z.boolean(),
  prompt: z.string().optional(),
});

interface VerificationAsk {
  channel: "email" | "sms";
  hint: string;
  prompt: string;
}

/**
 * Whether the page is now asking for a verification code, from either
 * sensor: the post-action probe's `autocomplete=one-time-code` rule, or the
 * broader look at a code-like input with verification wording around it.
 */
async function verificationAsked(
  sessionId: string,
  probe: Awaited<ReturnType<typeof inspectPostActionBrowserState>>
): Promise<VerificationAsk | undefined> {
  const asked = await parseResult(
    sessionId,
    verificationCodeProbeCode,
    verificationProbeSchema,
    "verification_probe"
  );
  if (asked?.present) {
    return {
      channel: asked.channel ?? "email",
      hint: asked.hint ?? "the site",
      prompt: asked.prompt ?? "",
    };
  }
  if (probe?.emailOtp || probe?.smsOtp) {
    return {
      channel: probe.smsOtp && !probe.emailOtp ? "sms" : "email",
      hint: probe.otpHint ?? "the site",
      prompt: "",
    };
  }
  return undefined;
}

/** The pause for a verification step, in the page's words and no more. */
async function verificationPause(
  input: ApplicationRunInput & { browserSessionId: string },
  ask: VerificationAsk,
  refused?: string
): Promise<FillStepResult> {
  const pause: ApplicationPauseReason =
    ask.channel === "email" ? "email_otp" : "user_input";
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: pause,
    status: "waiting",
  });
  const said = ask.prompt ? ` The page says: "${ask.prompt}"` : "";
  return {
    applyUrl: input.applyUrl,
    message: applicationPauseMessage(
      pause,
      ask.channel === "email"
        ? `${ask.hint} is asking for the verification code it just emailed the candidate before it will take the submit for ${input.applyUrl}.${said}${refused ? ` The last code was not accepted: ${refused}.` : ""} The form is complete and the browser is held open; enter the code with continue_application.`
        : `${ask.hint} is asking for a verification code sent by SMS before it will take the submit for ${input.applyUrl}.${said}${refused ? ` The last code was not accepted: ${refused}.` : ""} The form is complete and the browser is held open.`
    ),
    pause,
  };
}

async function completeSubmission(
  input: ApplicationRunInput & { browserSessionId: string }
): Promise<FillStepResult> {
  // The confirmation screen, for the candidate, while the browser is still on
  // it. The channel posts it the way it posts the review.
  const captured = await recordSubmissionConfirmationEvidence(
    input.scope,
    input.browserSessionId,
    { applyUrl: input.applyUrl, role: input.role }
  ).catch(() => false);
  applicationExecutionLog({
    captured,
    event: "runner.confirmation_screenshot",
    execution_id: input.executionId,
  });
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: null,
    status: "completed",
  });
  await forgetRunAnswers(input.scope, input.executionId).catch(() => undefined);
  return {
    applyUrl: input.applyUrl,
    done: true,
    message: `Submitted ${input.role} at ${input.applyUrl}.`,
  };
}

/**
 * Enters a verification code the page asked for after the submit.
 *
 * Returns nothing when no code is being asked for, so the caller can carry on
 * with the submit; otherwise the run's next state: done when the page
 * confirms the application, or the same verification pause again, carrying
 * the page's complaint, when the code was refused. The code is typed into the
 * page and never logged or echoed.
 */
export async function enterVerificationCode(
  input: ApplicationRunInput & { browserSessionId: string; code: string }
): Promise<FillStepResult | undefined> {
  const code = input.code.replace(/[\s-]+/gu, "");
  if (code === "") return undefined;
  const asked = await verificationAsked(input.browserSessionId, undefined);
  if (!asked) return undefined;
  const entered = await parseResult(
    input.browserSessionId,
    enterVerificationCodeCode(code),
    z.object({
      clicked: z.boolean(),
      confirmed: z.boolean(),
      entered: z.boolean(),
      errors: z.array(z.string()).default([]),
      href: z.string().optional(),
      remaining: z.number().default(0),
    }),
    "enter_code"
  );
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  const submitted =
    probe?.submitted === true ||
    (entered?.confirmed === true && entered.remaining === 0);
  const complaint = (entered?.errors ?? []).join("; ").slice(0, 300);
  // Outcome only: which channel, whether the code went in, what the page
  // said, whether the application is now in. Never the code.
  applicationExecutionLog({
    apply_url: input.applyUrl,
    channel: asked.channel,
    clicked: entered?.clicked === true,
    entered: entered?.entered === true,
    errors: complaint || "none",
    event: "runner.verification",
    execution_id: input.executionId,
    remaining: entered?.remaining ?? 0,
    submitted,
  });
  await recordBrowserRunCheckpoint(input.scope, input.browserSessionId, {
    action: "submit",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "submit",
    state: submitted ? "submission_observed" : "blocked",
  }).catch(() => undefined);
  if (submitted) return completeSubmission(input);
  if (entered?.entered !== true || entered.remaining > 0 || complaint) {
    return verificationPause(
      input,
      asked,
      complaint || "the page still asks for a code"
    );
  }
  // The code went in and the dialog closed, but nothing confirmed the
  // application yet: the submit itself is what is left.
  return undefined;
}

/**
 * The largest resume whose bytes also travel inside the attach script. The
 * staged path is always tried first; the bytes are the fallback for a path
 * the browser cannot read, and a file this size is well past any resume.
 */
const maxInlineResumeBytes = 4 * 1024 * 1024;

interface StagedResume {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  /** The browser-local path the file goes by; the mapper's name for it. */
  path: string;
  /** Whether the bytes actually reached that path. */
  staged: boolean;
}

/**
 * Brings the default resume to the browser, and says so either way.
 *
 * Every failure here used to be swallowed into "no resume", which the mapper
 * treated as a form with no resume slot: nothing attached, nothing asked,
 * nothing logged, and the ATS refused the submit. A read that fails is logged
 * and treated as no resume; a staging that fails keeps the bytes, so the
 * attach can still place them through the script itself.
 */
async function stageResume(
  input: ApplicationRunInput & { browserSessionId: string }
): Promise<StagedResume | undefined> {
  let document;
  try {
    document = await readOrImportDefaultResume(input.scope);
  } catch (error) {
    applicationExecutionLog({
      error: error instanceof Error ? error.message : "unknown",
      event: "runner.resume_read_failed",
      execution_id: input.executionId,
    });
    return undefined;
  }
  if (!document) {
    applicationExecutionLog({
      event: "runner.resume_missing",
      execution_id: input.executionId,
    });
    return undefined;
  }
  const filename = document.filename.replace(/[^\w.-]+/gu, "_");
  const path = `/tmp/goforay-default-resume-${filename}`;
  const staged: StagedResume = {
    bytes: document.bytes,
    filename,
    mimeType: document.mimeType,
    path,
    staged: false,
  };
  try {
    await browserProvider.stageFile(input.browserSessionId, {
      bytes: document.bytes,
      path,
    });
    staged.staged = true;
  } catch (error) {
    applicationExecutionLog({
      error: error instanceof Error ? error.message : "unknown",
      event: "runner.resume_stage_failed",
      execution_id: input.executionId,
    });
  }
  // Shape and size only, never contents.
  applicationExecutionLog({
    byte_size: document.bytes.byteLength,
    event: "runner.resume_staged",
    execution_id: input.executionId,
    extension: filename.split(".").pop() ?? "",
    path: staged.staged ? "ok" : "unavailable",
  });
  return staged;
}

/**
 * Puts the resume on the form and refuses to move on until it is there.
 *
 * Runs whenever a resume is on file, whether or not the scan mapped a control
 * to it: the script finds a resume slot the scan missed by its own wording. A
 * page with no file input at all is simply not one that takes a resume. Any
 * other failure is a pause, in plain words and with the reason, because the
 * alternative is a submit the ATS refuses for a file the candidate already
 * gave us.
 */
async function attachResume(
  input: ApplicationRunInput & { browserSessionId: string },
  resume: StagedResume,
  fileFills: MappedFill[],
  fields: Map<string, VisibleFormField>
): Promise<FillStepResult | undefined> {
  const payload =
    resume.bytes.byteLength <= maxInlineResumeBytes
      ? {
          base64: resume.bytes.toString("base64"),
          mimeType: resume.mimeType,
          name: resume.filename,
        }
      : undefined;
  const attachResultSchema = z.object({
    filename: z.string().optional(),
    found: z.string().optional(),
    inventory: z.array(z.string()).optional(),
    ok: z.boolean(),
    reason: z.string().optional(),
    shown: z.boolean().optional(),
    via: z.string().optional(),
  });
  // Where the Playwright code runs decides which route can work. On Kernel
  // it runs on the browser's own machine, so the staged path is the cheap
  // first choice. On the gateway it runs in the gateway's process and the
  // browser is at Brightdata: a path is resolved there, where the file is not,
  // and Chromium attaches nothing without complaint. The bytes go first.
  const order: ("path" | "payload")[] =
    browserProvider.name === "gateway"
      ? ["payload", "path"]
      : ["path", "payload"];
  const script = { label: "attach_resume", timeoutSec: 90 };
  const targets = fileFills.length > 0 ? fileFills : [undefined];
  for (const fill of targets) {
    const selector = fill ? { selector: fill.selector } : {};
    const path = resume.staged ? { path: resume.path } : {};
    let attached: z.infer<typeof attachResultSchema> | undefined;
    let failure: string | undefined;
    try {
      const run = await runScript(
        input.browserSessionId,
        attachFileCode({
          ...(payload ? { payload } : {}),
          ...path,
          ...selector,
          order,
        }),
        attachResultSchema,
        script
      );
      attached = run.data;
      failure = run.error;
    } catch (error) {
      // A script carrying the bytes can be too large for the provider to take
      // at all. That is not the page's answer, so try once more with the
      // staged path alone before calling it a failure.
      const message = error instanceof Error ? error.message : "unknown";
      const retry =
        payload && resume.staged
          ? await runScript(
              input.browserSessionId,
              attachFileCode({ ...path, ...selector, order: ["path"] }),
              attachResultSchema,
              script
            ).catch(() => undefined)
          : undefined;
      attached = retry?.data;
      failure = retry?.error ?? message.slice(0, 200);
    }
    const label = fileSlotName(
      fill ? (fields.get(fill.selector)?.label ?? "") : ""
    );
    if (attached?.ok) {
      applicationExecutionLog({
        event: "runner.resume_attached",
        execution_id: input.executionId,
        found: attached.found ?? "",
        selector: fill?.selector ?? "",
        shown: attached.shown === true,
        via: attached.via ?? "",
      });
      continue;
    }
    // The script's own verdict, else the error the browser raised running it.
    // "Returned nothing" was all a run could say before, with the real reason,
    // a gateway timeout or a thrown call, dropped on the floor.
    const reason =
      attached?.reason ??
      (failure
        ? `the browser failed running the attach: ${failure}`
        : "the browser returned nothing");
    // No file input anywhere is a form that does not take a resume, which is
    // no failure. A slot that exists and would not take the file is.
    if (reason === "missing" && !fill) {
      applicationExecutionLog({
        event: "runner.resume_no_slot",
        execution_id: input.executionId,
      });
      return undefined;
    }
    applicationExecutionLog({
      event: "runner.resume_attach_failed",
      execution_id: input.executionId,
      found: attached?.found ?? "",
      inventory: (attached?.inventory ?? []).slice(0, 6).join(" | "),
      reason: reason.slice(0, 300),
      selector: fill?.selector ?? "",
      via: attached?.via ?? "",
    });
    await updateApplicationRun({
      executionId: input.executionId,
      pauseReason: "user_input",
      status: "waiting",
    });
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        `the resume on file could not be attached to ${label} on ${input.applyUrl}: ${reason}. The file itself is fine; do not ask the candidate for it again.`
      ),
      pause: "user_input",
    };
  }
  return undefined;
}

/**
 * Runs a script and keeps what went wrong.
 *
 * The provider answers every script with `success`, an `error` when the code
 * threw or timed out, and a `result` otherwise. Reading only the result meant
 * a failed script and a script that returned nothing were the same thing, and
 * the attach that died on the gateway's timeout was logged as "the browser
 * returned nothing". The error text is the browser's own, never a value the
 * runner typed, so it is safe to carry and to log.
 */
async function runScript<T extends z.ZodType>(
  sessionId: string,
  code: string,
  schema: T,
  options: { label: string; timeoutSec?: number }
): Promise<{ data?: z.infer<T>; error?: string }> {
  const response = await browserProvider.executePlaywright(sessionId, {
    code,
    ...(options.timeoutSec === undefined
      ? {}
      : { timeoutSec: options.timeoutSec }),
  });
  const parsed = schema.safeParse(response.result);
  if (parsed.success) return { data: parsed.data };
  const error = (
    response.error ??
    (response.success
      ? `the script returned ${response.result === undefined ? "nothing" : `an unexpected ${typeof response.result}`}`
      : "the script failed without a message")
  )
    .replace(/\s+/gu, " ")
    .slice(0, 300);
  applicationExecutionLog({
    error,
    event: "runner.script_failed",
    script: options.label,
    success: response.success,
  });
  return { error };
}

async function parseResult<T extends z.ZodType>(
  sessionId: string,
  code: string,
  schema: T,
  label = "unnamed"
): Promise<z.infer<T> | undefined> {
  const { data } = await runScript(sessionId, code, schema, { label });
  return data;
}
