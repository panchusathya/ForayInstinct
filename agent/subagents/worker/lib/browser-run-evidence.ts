import { captureMaskedKernelScreenshot } from "@/agent/subagents/worker/lib/kernel-screenshot";
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
  await recordBrowserRunCheckpoint(scope, sessionId, {
    ...checkpoint,
    page,
    ...(evidence === undefined
      ? {}
      : {
          actions: [...(checkpoint.actions ?? []), evidence],
          state: "submission_observed",
        }),
  }).catch((error: unknown) => {
    console.error("[browser-checkpoint] persistence failed", {
      error:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "unknown",
      phase: checkpoint.phase,
      session_id: sessionId,
    });
  });
  if (evidence === undefined) return;
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
      page,
      png,
    });
  } catch (error: unknown) {
    console.error("[submission-screenshot] capture failed", {
      error:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "unknown",
      session_id: sessionId,
    });
  }
}
