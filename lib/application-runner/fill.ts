import { inspectPostActionBrowserState } from "@/agent/subagents/worker/lib/post-action-browser-state";
import { recordSubmissionReviewEvidence } from "@/agent/subagents/worker/lib/browser-run-evidence";
import {
  readCandidateContactIdentity,
  readCandidateProfile,
} from "@/db/services/candidate-profile";
import { readOrImportDefaultResume } from "@/db/services/default-resume";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import { updateApplicationRun } from "@/db/services/application-executions";
import { browserProvider } from "@/lib/browser";
import { suggestUnmappedFills } from "@/lib/application-runner/ambiguous";
import {
  mapProfileToFormFields,
  type MappedFill,
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
} from "@/lib/application-runner/types";
import { applicationPauseMessage } from "@/lib/task-completion";
import { z } from "zod";

export type FillStepResult =
  | { applyUrl: string; pause: ApplicationPauseReason; message: string }
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
  empty: z.array(z.object({ label: z.string(), selector: z.string() })),
});

/**
 * Applies fills and returns the selectors the page refused.
 *
 * The script's report used to be discarded, which is how a form could be
 * offered for approval with a required question still blank: nothing ever
 * compared what was asked for against what took.
 */
async function applyFills(sessionId: string, fills: MappedFill[]) {
  if (fills.length === 0) return [];
  const applied = await parseResult(
    sessionId,
    applyFillsCode(fills),
    z.object({
      filled: z.array(z.string()),
      skipped: z.array(z.object({ reason: z.string(), selector: z.string() })),
    })
  );
  return applied?.skipped ?? [];
}

export async function fillVisibleForm(
  input: ApplicationRunInput & { browserSessionId: string; answers?: string }
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
  const [profile, identity] = await Promise.all([
    readCandidateProfile(input.scope),
    readCandidateContactIdentity(input.scope),
  ]);
  const resume = await stageResume(input).catch(() => undefined);
  const mapped = mapProfileToFormFields({
    fields,
    identity,
    profile,
    resumePath: resume?.path,
  });
  await applyFills(
    input.browserSessionId,
    mapped.fills.filter((fill) => !fill.value.startsWith("/tmp/"))
  );
  for (const fill of mapped.fills.filter((row) =>
    row.value.startsWith("/tmp/")
  )) {
    await browserProvider.executePlaywright(input.browserSessionId, {
      code: setFileInputCode(fill.selector, fill.value),
    });
  }
  if (mapped.unmapped.length > 0) {
    const helper = await suggestUnmappedFills({
      answers: input.answers,
      fields: mapped.unmapped,
      profileSummary: [
        profile.legalFirstName,
        profile.legalLastName,
        identity.email,
        profile.locationCity,
      ]
        .filter(Boolean)
        .join(" "),
    });
    if (helper.fills.length > 0) {
      await applyFills(input.browserSessionId, helper.fills);
    }
    if (helper.blocker) {
      return {
        applyUrl: input.applyUrl,
        message: applicationPauseMessage(
          "user_input",
          helper.blocker.replace(/^Needs user input:\s*/iu, "")
        ),
        pause: "user_input",
      };
    }
  }
  // Ask the page itself what is still blank. A control the mapper never saw,
  // or a value it would not accept, is invisible upstream — this is the only
  // check that stands between an incomplete form and an approval prompt.
  const remaining = await parseResult(
    input.browserSessionId,
    collectEmptyRequiredFieldsCode,
    emptyRequiredSchema
  );
  const stillEmpty = remaining?.empty ?? [];
  if (stillEmpty.length > 0) {
    const asked = stillEmpty
      .map((field) => field.label.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .slice(0, 5);
    await updateApplicationRun({
      executionId: input.executionId,
      pauseReason: "user_input",
      status: "waiting",
    });
    return {
      applyUrl: input.applyUrl,
      message: applicationPauseMessage(
        "user_input",
        asked.length > 0
          ? `these required questions are still blank: ${asked.join("; ")}.`
          : `${String(stillEmpty.length)} required questions are still blank.`
      ),
      pause: "user_input",
    };
  }
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
  const click = await parseResult(
    input.browserSessionId,
    clickSubmitCode,
    z.object({
      clicked: z.boolean(),
      errors: z.array(z.string()).default([]),
      navigated: z.boolean().default(false),
    })
  );
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  const submitted = probe?.submitted === true;
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
  const complaint = (click?.errors ?? [])
    .map((error) => error.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
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
