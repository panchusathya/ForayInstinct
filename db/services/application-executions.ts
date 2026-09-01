import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { applicationExecutionEvents, applicationExecutions, db } from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import {
  APPLICATION_WORKER_ACTIVE_MS,
  APPLICATION_WATCHDOG_LEAD_MS,
  applicationExecutionLog,
  executionId,
  isApplicationWorkerDeadlineReached,
  type ApplicationIdentity,
} from "@/lib/application-execution";

type ExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "timed_out";

export async function createApplicationExecution(input: {
  callId: string;
  identity: ApplicationIdentity;
  model: string;
  rootSessionId: string;
  scope: AccessScope;
}) {
  const id = executionId(input.rootSessionId, input.callId);
  const now = new Date().toISOString();
  await db
    .insert(applicationExecutions)
    .values({
      applyUrl: input.identity.applyUrl,
      company: input.identity.company,
      createdAt: now,
      createdByUserId: input.scope.userId,
      id,
      model: input.model,
      parentCallId: input.callId,
      role: input.identity.role,
      rootSessionId: input.rootSessionId,
      status: "queued",
      updatedAt: now,
      workspaceId: input.scope.workspaceId,
    })
    .onConflictDoNothing();
  await recordApplicationExecutionEvent({
    executionId: id,
    eventId: `dispatch:${id}`,
    eventType: "worker.dispatched",
    stage: "dispatch",
    status: "queued",
  });
  applicationExecutionLog({
    apply_url: input.identity.applyUrl,
    company: input.identity.company,
    event: "worker.dispatched",
    execution_id: id,
    model: input.model,
    parent_call_id: input.callId,
    role: input.identity.role,
    root_session_id: input.rootSessionId,
    status: "queued",
  });
  return id;
}

export async function attachApplicationWorker(input: {
  callId: string;
  rootSessionId: string;
  workerSessionId: string;
}) {
  const id = executionId(input.rootSessionId, input.callId);
  const [execution] = await db
    .update(applicationExecutions)
    .set({
      status: "running",
      updatedAt: new Date().toISOString(),
      workerSessionId: input.workerSessionId,
    })
    .where(eq(applicationExecutions.id, id))
    .returning({
      applyUrl: applicationExecutions.applyUrl,
      company: applicationExecutions.company,
      model: applicationExecutions.model,
      role: applicationExecutions.role,
    });
  if (execution) {
    applicationExecutionLog({
      apply_url: execution.applyUrl,
      company: execution.company,
      event: "worker.created",
      execution_id: id,
      model: execution.model,
      parent_call_id: input.callId,
      role: execution.role,
      root_session_id: input.rootSessionId,
      status: "running",
      worker_session_id: input.workerSessionId,
    });
  }
  return id;
}

export async function updateApplicationExecutionForWorker(input: {
  eventId: string;
  eventType: string;
  rootSessionId: string;
  parentCallId: string;
  stage: string;
  status?: ExecutionStatus;
  startActive?: boolean;
  toolName?: string;
  turnId?: string;
  workerSessionId: string;
  errorCode?: string;
}) {
  const id = executionId(input.rootSessionId, input.parentCallId);
  const now = new Date().toISOString();
  const status = input.status ?? "running";
  const active = input.startActive === true;
  const result = await db
    .update(applicationExecutions)
    .set({
      ...(active
        ? { activeStartedAt: now, activeTurnId: input.turnId ?? null }
        : status === "waiting" ||
            status === "completed" ||
            status === "failed" ||
            status === "timed_out"
          ? { activeStartedAt: null, activeTurnId: null }
          : {}),
      finishedAt:
        status === "completed" || status === "failed" || status === "timed_out"
          ? now
          : null,
      status,
      updatedAt: now,
      workerSessionId: input.workerSessionId,
    })
    .where(
      and(
        eq(applicationExecutions.id, id),
        ne(applicationExecutions.status, "timed_out")
      )
    )
    .returning({
      activeStartedAt: applicationExecutions.activeStartedAt,
      applyUrl: applicationExecutions.applyUrl,
      company: applicationExecutions.company,
      id: applicationExecutions.id,
      model: applicationExecutions.model,
      role: applicationExecutions.role,
    });
  if (!result[0]) return;
  await recordApplicationExecutionEvent({
    errorCode: input.errorCode,
    eventId: input.eventId,
    eventType: input.eventType,
    executionId: id,
    stage: input.stage,
    status,
    toolName: input.toolName,
  });
  applicationExecutionLog({
    active_elapsed_ms: result[0].activeStartedAt
      ? Math.max(0, Date.now() - Date.parse(result[0].activeStartedAt))
      : 0,
    apply_url: result[0].applyUrl,
    company: result[0].company,
    event: input.eventType,
    execution_id: id,
    model: result[0].model,
    parent_call_id: input.parentCallId,
    role: result[0].role,
    root_session_id: input.rootSessionId,
    stage: input.stage,
    status,
    worker_session_id: input.workerSessionId,
  });
}

export async function attachBrowserToApplicationExecution(
  scope: AccessScope,
  browserSessionId: string,
  workerSessionId: string
) {
  const [execution] = await db
    .update(applicationExecutions)
    .set({ browserSessionId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(applicationExecutions.workspaceId, scope.workspaceId),
        eq(applicationExecutions.workerSessionId, workerSessionId)
      )
    )
    .returning({
      applyUrl: applicationExecutions.applyUrl,
      company: applicationExecutions.company,
      id: applicationExecutions.id,
      model: applicationExecutions.model,
      role: applicationExecutions.role,
      rootSessionId: applicationExecutions.rootSessionId,
    });
  if (!execution) return;
  await recordApplicationExecutionEvent({
    eventId: `browser:${browserSessionId}`,
    eventType: "browser.created",
    executionId: execution.id,
    stage: "browser",
    status: "running",
  });
  applicationExecutionLog({
    apply_url: execution.applyUrl,
    browser_session_id: browserSessionId,
    company: execution.company,
    event: "browser.created",
    execution_id: execution.id,
    model: execution.model,
    role: execution.role,
    root_session_id: execution.rootSessionId,
    status: "running",
    worker_session_id: workerSessionId,
  });
}

export async function assertApplicationWorkerWithinBudget(
  rootSessionId: string,
  parentCallId: string
) {
  const id = executionId(rootSessionId, parentCallId);
  const [execution] = await db
    .select({
      activeStartedAt: applicationExecutions.activeStartedAt,
      status: applicationExecutions.status,
    })
    .from(applicationExecutions)
    .where(eq(applicationExecutions.id, id))
    .limit(1);
  if (!execution) return;
  if (execution.status === "timed_out") {
    throw new Error("Application worker exceeded the 20-minute safety limit.");
  }
  if (
    execution.status === "running" &&
    execution.activeStartedAt &&
    isApplicationWorkerDeadlineReached(execution.activeStartedAt)
  ) {
    throw new Error("Application worker exceeded the 20-minute safety limit.");
  }
}

export async function listApplicationExecutionTraces(
  scope: AccessScope,
  limit = 50
) {
  return db
    .select({
      activeStartedAt: applicationExecutions.activeStartedAt,
      applyUrl: applicationExecutions.applyUrl,
      browserSessionId: applicationExecutions.browserSessionId,
      company: applicationExecutions.company,
      model: applicationExecutions.model,
      role: applicationExecutions.role,
      rootSessionId: applicationExecutions.rootSessionId,
      status: applicationExecutions.status,
      updatedAt: applicationExecutions.updatedAt,
      workerSessionId: applicationExecutions.workerSessionId,
    })
    .from(applicationExecutions)
    .where(eq(applicationExecutions.workspaceId, scope.workspaceId))
    .orderBy(desc(applicationExecutions.updatedAt))
    .limit(limit);
}

export async function findRestartableApplicationExecutions(
  scope: AccessScope,
  query: string
) {
  const term = query.trim().slice(0, 160);
  if (!term) return [];
  return db
    .select({
      applyUrl: applicationExecutions.applyUrl,
      company: applicationExecutions.company,
      role: applicationExecutions.role,
      rootSessionId: applicationExecutions.rootSessionId,
      status: applicationExecutions.status,
    })
    .from(applicationExecutions)
    .where(
      and(
        eq(applicationExecutions.workspaceId, scope.workspaceId),
        or(
          ilike(applicationExecutions.company, `%${term}%`),
          ilike(applicationExecutions.role, `%${term}%`),
          ilike(applicationExecutions.applyUrl, `%${term}%`)
        )
      )
    )
    .orderBy(desc(applicationExecutions.updatedAt))
    .limit(3);
}

export async function claimOverdueApplicationExecutions(now = new Date()) {
  const deadline = new Date(
    now.getTime() -
      (APPLICATION_WORKER_ACTIVE_MS - APPLICATION_WATCHDOG_LEAD_MS)
  ).toISOString();
  const rows = await db
    .select({
      activeStartedAt: applicationExecutions.activeStartedAt,
      applyUrl: applicationExecutions.applyUrl,
      company: applicationExecutions.company,
      executionId: applicationExecutions.id,
      model: applicationExecutions.model,
      parentCallId: applicationExecutions.parentCallId,
      role: applicationExecutions.role,
      rootSessionId: applicationExecutions.rootSessionId,
      workerSessionId: applicationExecutions.workerSessionId,
    })
    .from(applicationExecutions)
    .where(
      and(
        inArray(applicationExecutions.status, ["queued", "running"]),
        isNotNull(applicationExecutions.workerSessionId),
        lte(applicationExecutions.activeStartedAt, deadline)
      )
    );
  const claimed: typeof rows = [];
  for (const row of rows) {
    const updated = await db
      .update(applicationExecutions)
      .set({
        status: "timed_out",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(applicationExecutions.id, row.executionId),
          inArray(applicationExecutions.status, ["queued", "running"])
        )
      )
      .returning({ id: applicationExecutions.id });
    if (updated.length) {
      await recordApplicationExecutionEvent({
        executionId: row.executionId,
        eventId: `timeout:${row.executionId}`,
        eventType: "worker.timed_out",
        stage: "watchdog",
        status: "timed_out",
      });
      applicationExecutionLog({
        active_elapsed_ms: row.activeStartedAt
          ? Math.max(0, now.getTime() - Date.parse(row.activeStartedAt))
          : 0,
        apply_url: row.applyUrl,
        company: row.company,
        event: "worker.timeout.claimed",
        execution_id: row.executionId,
        model: row.model,
        parent_call_id: row.parentCallId,
        reason: "active_time_limit",
        role: row.role,
        root_session_id: row.rootSessionId,
        status: "timed_out",
        worker_session_id: row.workerSessionId,
      });
      claimed.push(row);
    }
  }
  return claimed;
}

async function recordApplicationExecutionEvent(input: {
  errorCode?: string;
  eventId: string;
  eventType: string;
  executionId: string;
  stage: string;
  status?: string;
  toolName?: string;
}) {
  await db
    .insert(applicationExecutionEvents)
    .values({
      createdAt: new Date().toISOString(),
      errorCode: input.errorCode,
      eventType: input.eventType,
      executionId: input.executionId,
      id: input.eventId,
      stage: input.stage,
      status: input.status,
      toolName: input.toolName,
    })
    .onConflictDoNothing();
}
