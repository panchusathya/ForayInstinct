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
  type VisibleFormField,
} from "@/lib/application-runner/form-map";
import {
  applyFillsCode,
  clickSubmitCode,
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
  required: z.boolean(),
  selector: z.string(),
  tag: z.string(),
  type: z.string(),
});

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
  if (mapped.fills.length > 0) {
    await browserProvider.executePlaywright(input.browserSessionId, {
      code: applyFillsCode(
        mapped.fills.filter((fill) => !fill.value.startsWith("/tmp/"))
      ),
    });
  }
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
      await browserProvider.executePlaywright(input.browserSessionId, {
        code: applyFillsCode(helper.fills),
      });
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

export async function submitApplication(
  input: ApplicationRunInput & { browserSessionId: string }
): Promise<FillStepResult> {
  await browserProvider.executePlaywright(input.browserSessionId, {
    code: clickSubmitCode,
  });
  const probe = await inspectPostActionBrowserState(
    input.browserSessionId
  ).catch(() => undefined);
  await recordBrowserRunCheckpoint(input.scope, input.browserSessionId, {
    action: "submit",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "submit",
    state: probe?.submitted ? "submission_observed" : "completed",
  }).catch(() => undefined);
  await updateApplicationRun({
    executionId: input.executionId,
    pauseReason: null,
    status: "completed",
  });
  return {
    applyUrl: input.applyUrl,
    done: true,
    message: probe?.submitted
      ? `Submitted ${input.role} at ${input.applyUrl}.`
      : `Submit control clicked for ${input.role}.`,
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
