import type { AccessScope } from "@/lib/access-scope";
import {
  recordBrowserRunCheckpoint,
  type BrowserRunCheckpointInput,
} from "@/db/services/browser-run-checkpoints";
import {
  browserPageLocation,
  observedSubmission,
} from "@/lib/browser-submission";
import { snapshotKernelPage } from "@/lib/manager/server/kernel-native-autofill";

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
  const evidence = snapshot
    ? observedSubmission(snapshot.url, snapshot.body)
    : undefined;
  await recordBrowserRunCheckpoint(scope, sessionId, {
    ...checkpoint,
    page: checkpoint.page ?? browserPageLocation(snapshot?.url),
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
}
