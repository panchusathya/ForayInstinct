import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { applicationExecutionEvents, applicationExecutions, db } from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import { releaseApplicationLease } from "@/db/services/application-leases";
import {
  APPLICATION_DISPATCH_GRACE_MS,
  APPLICATION_DUPLICATE_WORKER_WINDOW_MS,
  applicationExecutionLog,
  executionId,
  type ApplicationIdentity,
} from "@/lib/application-execution";
import { workerBlockerPrefix } from "@/lib/task-completion";

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
  if (status === "completed" || status === "failed" || status === "timed_out") {
    await releaseApplicationLease({
      executionId: id,
      workerSessionId: input.workerSessionId,
    });
  }
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

/**
 * One worker per posting. The root is told to call `worker` once per
 * assignment, but nothing in eve stops a second dispatch for the same apply
 * URL, and two workers on one form double the spend and fight over the
 * browser. Every worker tool passes through here first, so a later duplicate
 * fails on its first call, before it can create or touch a browser.
 */
export async function assertNoConcurrentApplicationWorker(input: {
  parentCallId: string;
  rootSessionId: string;
  workerSessionId: string;
  now?: Date;
}) {
  const id = executionId(input.rootSessionId, input.parentCallId);
  const [mine] = await db
    .select({
      applyUrl: applicationExecutions.applyUrl,
      createdAt: applicationExecutions.createdAt,
      workspaceId: applicationExecutions.workspaceId,
    })
    .from(applicationExecutions)
    .where(eq(applicationExecutions.id, id))
    .limit(1);
  // No trace row or no identity header: nothing to compare against.
  if (!mine || mine.applyUrl === "") return;
  const now = (input.now ?? new Date()).getTime();
  const since = new Date(
    now - APPLICATION_DUPLICATE_WORKER_WINDOW_MS
  ).toISOString();
  const dispatchedSince = new Date(
    now - APPLICATION_DISPATCH_GRACE_MS
  ).toISOString();
  const [other] = await db
    .select({
      createdAt: applicationExecutions.createdAt,
      id: applicationExecutions.id,
      workerSessionId: applicationExecutions.workerSessionId,
    })
    .from(applicationExecutions)
    .where(
      and(
        eq(applicationExecutions.workspaceId, mine.workspaceId),
        eq(applicationExecutions.applyUrl, mine.applyUrl),
        ne(applicationExecutions.id, id),
        inArray(applicationExecutions.status, ["queued", "running", "waiting"]),
        gte(applicationExecutions.updatedAt, since),
        or(
          // A resumed worker gets a fresh row for the same posting while its
          // earlier row is still `waiting`; its own rows never lock it out.
          and(
            isNotNull(applicationExecutions.workerSessionId),
            ne(applicationExecutions.workerSessionId, input.workerSessionId)
          ),
          // A row no worker has attached to yet is only a worker on its way
          // for a moment; after that it is a dispatch eve refused.
          and(
            isNull(applicationExecutions.workerSessionId),
            gte(applicationExecutions.createdAt, dispatchedSince)
          )
        )
      )
    )
    .orderBy(
      asc(applicationExecutions.createdAt),
      asc(applicationExecutions.id)
    )
    .limit(1);
  if (!other) return;
  // Both rows of one dispatch batch exist before either worker runs, so the
  // earliest row wins deterministically without a lock.
  const otherIsEarlier =
    other.createdAt < mine.createdAt ||
    (other.createdAt === mine.createdAt && other.id < id);
  if (!otherIsEarlier) return;
  await recordApplicationExecutionEvent({
    eventId: `duplicate:${id}`,
    eventType: "worker.duplicate_blocked",
    executionId: id,
    stage: "guard",
    status: "failed",
  });
  applicationExecutionLog({
    apply_url: mine.applyUrl,
    event: "worker.duplicate_blocked",
    execution_id: id,
    existing_execution_id: other.id,
    existing_worker_session_id: other.workerSessionId,
    root_session_id: input.rootSessionId,
    worker_session_id: input.workerSessionId,
  });
  throw new Error(
    `${workerBlockerPrefix("existingWorker")} another worker (session ${other.workerSessionId ?? "pending"}) is already handling ${mine.applyUrl}. Do not create a browser or call any other browser tool; call final_output with status "failure" and this message verbatim.`
  );
}

/** Whether a worker of this root session is still running or parked on the candidate. */
export async function hasUnfinishedApplicationExecution(
  rootSessionId: string,
  since: Date
) {
  const [row] = await db
    .select({ id: applicationExecutions.id })
    .from(applicationExecutions)
    .where(
      and(
        eq(applicationExecutions.rootSessionId, rootSessionId),
        inArray(applicationExecutions.status, ["queued", "running", "waiting"]),
        gte(applicationExecutions.updatedAt, since.toISOString())
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Counts one kind of trace event across every execution of a root session. */
export async function countRecentApplicationExecutionEvents(input: {
  eventType: string;
  rootSessionId: string;
  since: Date;
}) {
  const rows = await db
    .select({ id: applicationExecutionEvents.id })
    .from(applicationExecutionEvents)
    .innerJoin(
      applicationExecutions,
      eq(applicationExecutionEvents.executionId, applicationExecutions.id)
    )
    .where(
      and(
        eq(applicationExecutions.rootSessionId, input.rootSessionId),
        eq(applicationExecutionEvents.eventType, input.eventType),
        gte(applicationExecutionEvents.createdAt, input.since.toISOString())
      )
    );
  return rows.length;
}

export async function listApplicationExecutionTraces(
  scope: AccessScope,
  query: {
    applyUrl?: string;
    executionId?: string;
    limit?: number;
  } = {}
) {
  const applyUrl = query.applyUrl?.trim() ?? "";
  const executionIdValue = query.executionId?.trim() ?? "";
  if (applyUrl === "" && executionIdValue === "") return [];
  const identity =
    applyUrl !== "" && executionIdValue !== ""
      ? or(
          eq(applicationExecutions.applyUrl, applyUrl),
          eq(applicationExecutions.id, executionIdValue)
        )
      : applyUrl !== ""
        ? eq(applicationExecutions.applyUrl, applyUrl)
        : eq(applicationExecutions.id, executionIdValue);
  return db
    .select({
      activeStartedAt: applicationExecutions.activeStartedAt,
      applyUrl: applicationExecutions.applyUrl,
      browserSessionId: applicationExecutions.browserSessionId,
      company: applicationExecutions.company,
      id: applicationExecutions.id,
      model: applicationExecutions.model,
      role: applicationExecutions.role,
      rootSessionId: applicationExecutions.rootSessionId,
      status: applicationExecutions.status,
      updatedAt: applicationExecutions.updatedAt,
      workerSessionId: applicationExecutions.workerSessionId,
    })
    .from(applicationExecutions)
    .where(
      and(eq(applicationExecutions.workspaceId, scope.workspaceId), identity)
    )
    .orderBy(desc(applicationExecutions.updatedAt))
    .limit(query.limit ?? 50);
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
