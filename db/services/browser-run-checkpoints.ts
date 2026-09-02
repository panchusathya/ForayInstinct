import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { applicationExecutions, browserRunCheckpoints, db } from "@/db";
import { listApplicationExecutionTraces } from "@/db/services/application-executions";

export interface BrowserRunCheckpointInput {
  action?: string;
  actions?: string[];
  attempt?: number;
  errorCode?: string;
  executionId?: string;
  page?: string;
  phase: string;
  state?: string;
  trace?: string[];
}

export async function recordBrowserRunCheckpoint(
  scope: AccessScope,
  sessionId: string,
  checkpoint: BrowserRunCheckpointInput
) {
  const executionId =
    checkpoint.executionId ??
    (await findExecutionIdForBrowserSession(scope, sessionId));
  await db.insert(browserRunCheckpoints).values({
    action: checkpoint.action,
    actions: checkpoint.actions ?? [],
    attempt: checkpoint.attempt ?? 0,
    createdAt: new Date().toISOString(),
    createdByUserId: scope.userId,
    errorCode: checkpoint.errorCode,
    executionId,
    page: checkpoint.page,
    phase: checkpoint.phase,
    sessionId,
    state: checkpoint.state,
    trace: checkpoint.trace ?? [],
    workspaceId: scope.workspaceId,
  });
}

export async function listBrowserRunCheckpoints(
  scope: AccessScope,
  sessionId: string
) {
  return db
    .select({
      action: browserRunCheckpoints.action,
      actions: browserRunCheckpoints.actions,
      attempt: browserRunCheckpoints.attempt,
      createdAt: browserRunCheckpoints.createdAt,
      errorCode: browserRunCheckpoints.errorCode,
      executionId: browserRunCheckpoints.executionId,
      page: browserRunCheckpoints.page,
      phase: browserRunCheckpoints.phase,
      sessionId: browserRunCheckpoints.sessionId,
      state: browserRunCheckpoints.state,
      trace: browserRunCheckpoints.trace,
    })
    .from(browserRunCheckpoints)
    .where(
      and(
        eq(browserRunCheckpoints.workspaceId, scope.workspaceId),
        eq(browserRunCheckpoints.sessionId, sessionId)
      )
    )
    .orderBy(desc(browserRunCheckpoints.createdAt));
}

export async function listRecentBrowserRunCheckpoints(
  scope: AccessScope,
  limit = 100
) {
  return db
    .select({
      action: browserRunCheckpoints.action,
      actions: browserRunCheckpoints.actions,
      attempt: browserRunCheckpoints.attempt,
      createdAt: browserRunCheckpoints.createdAt,
      errorCode: browserRunCheckpoints.errorCode,
      executionId: browserRunCheckpoints.executionId,
      page: browserRunCheckpoints.page,
      phase: browserRunCheckpoints.phase,
      sessionId: browserRunCheckpoints.sessionId,
      state: browserRunCheckpoints.state,
      trace: browserRunCheckpoints.trace,
    })
    .from(browserRunCheckpoints)
    .where(eq(browserRunCheckpoints.workspaceId, scope.workspaceId))
    .orderBy(desc(browserRunCheckpoints.createdAt))
    .limit(limit);
}

export async function listBrowserRunCheckpointsForExecution(
  scope: AccessScope,
  query: {
    applyUrl?: string;
    executionId?: string;
    limit?: number;
  }
) {
  const executions = await listApplicationExecutionTraces(scope, query);
  if (executions.length === 0) return [];
  const executionIds = executions.map((row) => row.id);
  const sessionIds = executions.flatMap((row) =>
    row.browserSessionId ? [row.browserSessionId] : []
  );
  const identity = [
    executionIds.length > 0
      ? inArray(browserRunCheckpoints.executionId, executionIds)
      : undefined,
    sessionIds.length > 0
      ? inArray(browserRunCheckpoints.sessionId, sessionIds)
      : undefined,
  ].filter((value) => value !== undefined);
  if (identity.length === 0) return [];
  return db
    .select({
      action: browserRunCheckpoints.action,
      actions: browserRunCheckpoints.actions,
      attempt: browserRunCheckpoints.attempt,
      createdAt: browserRunCheckpoints.createdAt,
      errorCode: browserRunCheckpoints.errorCode,
      executionId: browserRunCheckpoints.executionId,
      page: browserRunCheckpoints.page,
      phase: browserRunCheckpoints.phase,
      sessionId: browserRunCheckpoints.sessionId,
      state: browserRunCheckpoints.state,
      trace: browserRunCheckpoints.trace,
    })
    .from(browserRunCheckpoints)
    .where(
      and(
        eq(browserRunCheckpoints.workspaceId, scope.workspaceId),
        identity.length === 1 ? identity[0] : or(...identity)
      )
    )
    .orderBy(desc(browserRunCheckpoints.createdAt))
    .limit(query.limit ?? 100);
}

async function findExecutionIdForBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  const [row] = await db
    .select({ id: applicationExecutions.id })
    .from(applicationExecutions)
    .where(
      and(
        eq(applicationExecutions.workspaceId, scope.workspaceId),
        eq(applicationExecutions.browserSessionId, sessionId)
      )
    )
    .orderBy(desc(applicationExecutions.updatedAt))
    .limit(1);
  return row?.id;
}
