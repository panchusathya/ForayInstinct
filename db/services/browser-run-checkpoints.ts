import { and, desc, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/access-scope";
import { browserRunCheckpoints, db } from "@/db";

export type BrowserRunCheckpointInput = {
  action?: string;
  actions?: string[];
  attempt?: number;
  errorCode?: string;
  page?: string;
  phase: string;
  state?: string;
  trace?: string[];
};

export async function recordBrowserRunCheckpoint(
  scope: AccessScope,
  sessionId: string,
  checkpoint: BrowserRunCheckpointInput
) {
  await db.insert(browserRunCheckpoints).values({
    action: checkpoint.action,
    actions: checkpoint.actions ?? [],
    attempt: checkpoint.attempt ?? 0,
    createdAt: new Date().toISOString(),
    createdByUserId: scope.userId,
    errorCode: checkpoint.errorCode,
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
