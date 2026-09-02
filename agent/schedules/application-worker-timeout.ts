import { Client } from "eve/client";
import { defineSchedule } from "eve/schedules";
import { getVercelOidcToken } from "@vercel/oidc";
import { claimOverdueApplicationLeases } from "@/db/services/application-leases";
import { applicationExecutionLog } from "@/lib/application-execution";
import { closeApplicationBrowser } from "@/lib/application-runner/browser";
import { env } from "@/lib/env";

/** Stops overdue application runs before they can exceed the 20-minute cap. */
export default defineSchedule({
  cron: "* * * * *",
  async run({ waitUntil }) {
    const overdueRuns = await claimOverdueApplicationLeases();
    if (!overdueRuns.length) return;
    const client = new Client({
      auth: {
        vercelOidc: { token: () => getVercelOidcToken() },
      },
      host: env.BETTER_AUTH_URL,
      redirect: "error",
    });
    for (const overdue of overdueRuns) {
      waitUntil(
        (async () => {
          if (
            overdue.workflowRunId &&
            !overdue.workflowRunId.startsWith("inline:")
          ) {
            try {
              const workflowApi = await import("workflow/api");
              await workflowApi.getRun(overdue.workflowRunId).cancel();
            } catch {
              // Best-effort cancel of the durable fill run.
            }
          }
          if (overdue.browserSessionId) {
            await closeApplicationBrowser({
              scope: {
                userId: overdue.createdByUserId,
                workspaceId: overdue.workspaceId,
              },
              sessionId: overdue.browserSessionId,
            }).catch(() => undefined);
          }
          const workerSessionId = overdue.workerSessionId;
          if (workerSessionId) {
            const session = client.sessions.attach(workerSessionId);
            await session.cancel().catch(() => undefined);
            await session
              .reset({
                reason:
                  "Application runner exceeded the 20-minute safety limit.",
              })
              .catch(() => undefined);
          }
          applicationExecutionLog({
            event: "runner.timed_out",
            execution_id: overdue.executionId,
            worker_session_id: workerSessionId,
            workflow_run_id: overdue.workflowRunId,
          });
        })()
      );
    }
  },
});
