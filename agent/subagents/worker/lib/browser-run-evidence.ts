import {
  captureMaskedKernelScreenshot,
  captureMaskedReviewScreenshots,
} from "@/agent/subagents/worker/lib/kernel-screenshot";
import type { AccessScope } from "@/lib/access-scope";
import { saveApplicationSubmissionScreenshot } from "@/db/services/application-submission-screenshots";
import {
  recordBrowserRunCheckpoint,
  type BrowserRunCheckpointInput,
} from "@/db/services/browser-run-checkpoints";
import {
  browserPageLocation,
  observedSubmission,
} from "@/lib/browser-submission";
import {
  currentKernelPageUrl,
  snapshotKernelPage,
} from "@/lib/manager/server/kernel-native-autofill";

export async function recordBrowserActionCheckpoint(
  scope: AccessScope,
  sessionId: string,
  checkpoint: BrowserRunCheckpointInput,
  signal?: AbortSignal
) {
  const snapshot = await snapshotKernelPage({
    browserSessionId: sessionId,
    signal,
  }).catch(() => undefined);
  const url =
    snapshot?.url ??
    (await currentKernelPageUrl({
      browserSessionId: sessionId,
      signal,
    }).catch(() => undefined));
  const evidence = snapshot
    ? observedSubmission(snapshot.url, snapshot.body)
    : url
      ? observedSubmission(url, "")
      : undefined;
  const page = checkpoint.page ?? browserPageLocation(url);
  const submitted = evidence !== undefined && checkpoint.state !== "failed";
  await recordBrowserRunCheckpoint(scope, sessionId, {
    ...checkpoint,
    page,
    ...(evidence === undefined
      ? {}
      : {
          // Evidence is useful for debugging and screenshot capture, but it
          // cannot turn a failed or incomplete browser action into a success.
          actions: [
            ...(checkpoint.actions ?? []),
            `submission evidence: ${evidence}`,
          ],
        }),
  }).catch((error: unknown) => {
    console.error("[browser-checkpoint] persistence failed", {
      error: evidenceErrorMessage(error),
      phase: checkpoint.phase,
      session_id: sessionId,
    });
  });
  if (!submitted) return;
  await persistSubmissionScreenshot(scope, sessionId, page, signal);
}

async function persistSubmissionScreenshot(
  scope: AccessScope,
  sessionId: string,
  page: string | undefined,
  signal?: AbortSignal
) {
  try {
    const png = await captureMaskedKernelScreenshot(sessionId, signal);
    if (png.byteLength === 0) return;
    await saveApplicationSubmissionScreenshot(scope, sessionId, {
      kind: "submitted",
      page,
      png,
    });
  } catch (error: unknown) {
    console.error("[submission-screenshot] capture failed", {
      error: evidenceErrorMessage(error),
      session_id: sessionId,
    });
  }
}

/**
 * The pause before an application's final submit. Captures the completed form
 * for the candidate to check and records the pause on the checkpoint trail, so
 * an application waiting on approval is distinguishable from one abandoned
 * mid-run. Deliberately never classified as `submission_observed`: nothing has
 * been submitted at this point.
 */
export async function recordSubmissionReviewEvidence(
  scope: AccessScope,
  sessionId: string,
  assignment: { applyUrl: string; role: string },
  signal?: AbortSignal
) {
  const page = await currentKernelPageUrl({
    browserSessionId: sessionId,
    signal,
  }).catch(() => undefined);
  const captures = await captureMaskedReviewScreenshots(sessionId, signal);
  for (const png of captures) {
    await saveApplicationSubmissionScreenshot(scope, sessionId, {
      kind: "review",
      page: browserPageLocation(page),
      png,
    });
  }
  await recordBrowserRunCheckpoint(scope, sessionId, {
    action: "review",
    // The coordinator matches a paused worker to the posting under discussion
    // from this trail, so the role and apply URL belong on the checkpoint.
    actions: [
      `role: ${assignment.role}`,
      `apply_url: ${assignment.applyUrl}`,
      `review screenshots: ${String(captures.length)}`,
    ],
    page: browserPageLocation(page),
    phase: "submission_approval",
    state: "awaiting_approval",
  }).catch((error: unknown) => {
    console.error("[submission-approval] persistence failed", {
      error: evidenceErrorMessage(error),
      session_id: sessionId,
    });
  });
  return captures.length;
}

function evidenceErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown";
}
