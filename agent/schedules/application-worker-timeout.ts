import { Client } from "eve/client";
import { defineSchedule } from "eve/schedules";
import { getVercelOidcToken } from "@vercel/oidc";
import { claimOverdueApplicationLeases } from "@/db/services/application-leases";
import { applicationExecutionLog } from "@/lib/application-execution";
import { env } from "@/lib/env";

/** Stops active application workers before they can exceed the 20-minute cap. */
export default defineSchedule({
  cron: "* * * * *",
  async run({ waitUntil }) {
    const workers = await claimOverdueApplicationLeases();
    if (!workers.length) return;
    const client = new Client({
      auth: {
        vercelOidc: { token: () => getVercelOidcToken() },
      },
      host: env.BETTER_AUTH_URL,
      redirect: "error",
    });
    for (const worker of workers) {
      const workerSessionId = worker.workerSessionId;
      if (!workerSessionId) continue;
      waitUntil(
        (async () => {
          const session = client.sessions.attach(workerSessionId);
          await session.cancel().catch(() => undefined);
          await session
            .reset({
              reason: "Application worker exceeded the 20-minute safety limit.",
            })
            .catch(() => undefined);
          applicationExecutionLog({
            event: "worker.timed_out",
            execution_id: worker.executionId,
            worker_session_id: workerSessionId,
          });
        })()
      );
    }
  },
});
