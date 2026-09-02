import { and, eq, lte, or } from "drizzle-orm";
import { applicationLeases, applicationExecutions, db } from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import {
  APPLICATION_WATCHDOG_LEAD_MS,
  applicationExecutionLog,
  applicationLeaseExpiresAt,
  executionId,
  isApplicationLeaseExpired,
} from "@/lib/application-execution";
import {
  alreadyInProgressStatus,
  workerBlockerPrefix,
} from "@/lib/task-completion";

export type ApplicationLeaseClaim =
  | { status: "acquired"; executionId: string; expiresAt: string }
  | {
      applyUrl: string;
      existingExecutionId: string;
      status: "already_in_progress";
      workerSessionId: string | null;
    };

function alreadyInProgressError(input: {
  applyUrl: string;
  workerSessionId?: string | null;
}) {
  return new Error(
    `${workerBlockerPrefix("existingWorker")} ${alreadyInProgressStatus}. another worker (session ${input.workerSessionId ?? "pending"}) is already handling ${input.applyUrl}. Do not create a browser or call any other browser tool; call final_output with status "failure" and this message verbatim.`
  );
}

export async function claimApplicationLease(input: {
  applyUrl: string;
  executionId: string;
  rootSessionId: string;
  scope: AccessScope;
  now?: Date;
}): Promise<ApplicationLeaseClaim> {
  if (input.applyUrl === "") {
    throw new Error("Application worker requires a posting apply_url.");
  }
  const now = input.now ?? new Date();
  const claimedAt = now.toISOString();
  const expiresAt = applicationLeaseExpiresAt(now);
  const inserted = await db
    .insert(applicationLeases)
    .values({
      applyUrl: input.applyUrl,
      claimedAt,
      createdByUserId: input.scope.userId,
      executionId: input.executionId,
      expiresAt,
      rootSessionId: input.rootSessionId,
      status: "held",
      workspaceId: input.scope.workspaceId,
    })
    .onConflictDoNothing()
    .returning({
      executionId: applicationLeases.executionId,
      expiresAt: applicationLeases.expiresAt,
    });
  if (inserted[0]) {
    applicationExecutionLog({
      apply_url: input.applyUrl,
      event: "lease.acquired",
      execution_id: input.executionId,
      expires_at: inserted[0].expiresAt,
      root_session_id: input.rootSessionId,
      status: "held",
    });
    return {
      executionId: inserted[0].executionId,
      expiresAt: inserted[0].expiresAt,
      status: "acquired",
    };
  }
  const [mine] = await db
    .select({
      executionId: applicationLeases.executionId,
      expiresAt: applicationLeases.expiresAt,
      status: applicationLeases.status,
      workerSessionId: applicationLeases.workerSessionId,
    })
    .from(applicationLeases)
    .where(eq(applicationLeases.executionId, input.executionId))
    .limit(1);
  if (mine?.status === "held") {
    return {
      executionId: mine.executionId,
      expiresAt: mine.expiresAt,
      status: "acquired",
    };
  }
  const [held] = await db
    .select({
      executionId: applicationLeases.executionId,
      workerSessionId: applicationLeases.workerSessionId,
    })
    .from(applicationLeases)
    .where(
      and(
        eq(applicationLeases.workspaceId, input.scope.workspaceId),
        eq(applicationLeases.applyUrl, input.applyUrl),
        eq(applicationLeases.status, "held")
      )
    )
    .limit(1);
  if (!held) {
    throw new Error("Application worker requires an application lease.");
  }
  applicationExecutionLog({
    apply_url: input.applyUrl,
    event: "lease.already_in_progress",
    execution_id: input.executionId,
    existing_execution_id: held.executionId,
    existing_worker_session_id: held.workerSessionId,
    root_session_id: input.rootSessionId,
    status: alreadyInProgressStatus,
  });
  return {
    applyUrl: input.applyUrl,
    existingExecutionId: held.executionId,
    status: "already_in_progress",
    workerSessionId: held.workerSessionId,
  };
}

export async function attachApplicationLeaseWorker(input: {
  executionId: string;
  workerSessionId: string;
}) {
  await db
    .update(applicationLeases)
    .set({ workerSessionId: input.workerSessionId })
    .where(
      and(
        eq(applicationLeases.executionId, input.executionId),
        eq(applicationLeases.status, "held")
      )
    );
}

export async function assertApplicationLeaseOwner(input: {
  parentCallId: string;
  rootSessionId: string;
  workerSessionId: string;
  now?: Date;
}) {
  const id = executionId(input.rootSessionId, input.parentCallId);
  const now = (input.now ?? new Date()).getTime();
  const [mine] = await db
    .select({
      applyUrl: applicationExecutions.applyUrl,
      workspaceId: applicationExecutions.workspaceId,
    })
    .from(applicationExecutions)
    .where(eq(applicationExecutions.id, id))
    .limit(1);
  const [lease] = mine?.applyUrl
    ? await db
        .select({
          applyUrl: applicationLeases.applyUrl,
          executionId: applicationLeases.executionId,
          expiresAt: applicationLeases.expiresAt,
          workerSessionId: applicationLeases.workerSessionId,
        })
        .from(applicationLeases)
        .where(
          and(
            eq(applicationLeases.workspaceId, mine.workspaceId),
            eq(applicationLeases.applyUrl, mine.applyUrl),
            eq(applicationLeases.status, "held")
          )
        )
        .limit(1)
    : await db
        .select({
          applyUrl: applicationLeases.applyUrl,
          executionId: applicationLeases.executionId,
          expiresAt: applicationLeases.expiresAt,
          workerSessionId: applicationLeases.workerSessionId,
        })
        .from(applicationLeases)
        .where(
          and(
            eq(applicationLeases.workerSessionId, input.workerSessionId),
            eq(applicationLeases.status, "held")
          )
        )
        .limit(1);
  if (!lease) {
    throw new Error("Application worker requires an application lease.");
  }
  if (isApplicationLeaseExpired(lease.expiresAt, now)) {
    throw new Error("Application worker exceeded the 20-minute safety limit.");
  }
  const owns =
    lease.executionId === id || lease.workerSessionId === input.workerSessionId;
  if (!owns) {
    throw alreadyInProgressError({
      applyUrl: lease.applyUrl,
      workerSessionId: lease.workerSessionId,
    });
  }
}

export async function releaseApplicationLease(input: {
  executionId?: string;
  workerSessionId?: string;
}) {
  const match = [
    input.executionId
      ? eq(applicationLeases.executionId, input.executionId)
      : undefined,
    input.workerSessionId
      ? eq(applicationLeases.workerSessionId, input.workerSessionId)
      : undefined,
  ].filter((value) => value !== undefined);
  if (match.length === 0) return;
  await db
    .update(applicationLeases)
    .set({ status: "released" })
    .where(
      and(
        eq(applicationLeases.status, "held"),
        match.length === 1 ? match[0] : or(...match)
      )
    );
}

export async function claimOverdueApplicationLeases(now = new Date()) {
  const deadline = new Date(
    now.getTime() + APPLICATION_WATCHDOG_LEAD_MS
  ).toISOString();
  const rows = await db
    .select({
      applyUrl: applicationLeases.applyUrl,
      browserSessionId: applicationExecutions.browserSessionId,
      createdByUserId: applicationLeases.createdByUserId,
      executionId: applicationLeases.executionId,
      expiresAt: applicationLeases.expiresAt,
      rootSessionId: applicationLeases.rootSessionId,
      workerSessionId: applicationLeases.workerSessionId,
      workflowRunId: applicationExecutions.workflowRunId,
      workspaceId: applicationLeases.workspaceId,
    })
    .from(applicationLeases)
    .leftJoin(
      applicationExecutions,
      eq(applicationLeases.executionId, applicationExecutions.id)
    )
    .where(
      and(
        eq(applicationLeases.status, "held"),
        lte(applicationLeases.expiresAt, deadline)
      )
    );
  const claimed: typeof rows = [];
  for (const row of rows) {
    const updated = await db
      .update(applicationLeases)
      .set({ status: "released" })
      .where(
        and(
          eq(applicationLeases.executionId, row.executionId),
          eq(applicationLeases.status, "held")
        )
      )
      .returning({ executionId: applicationLeases.executionId });
    if (!updated.length) continue;
    await db
      .update(applicationExecutions)
      .set({
        finishedAt: now.toISOString(),
        status: "timed_out",
        updatedAt: now.toISOString(),
      })
      .where(eq(applicationExecutions.id, row.executionId));
    applicationExecutionLog({
      apply_url: row.applyUrl,
      event: "lease.timed_out",
      execution_id: row.executionId,
      expires_at: row.expiresAt,
      root_session_id: row.rootSessionId,
      status: "timed_out",
      worker_session_id: row.workerSessionId,
    });
    claimed.push(row);
  }
  return claimed;
}
