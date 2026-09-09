import { z } from "zod";
import {
  hasUnfinishedApplicationExecution,
  listRecentApplicationExecutions,
} from "@/db/services/application-executions";
import type { AccessScope } from "@/lib/access-scope";
import { env } from "@/lib/env";
import { eveSessionClient } from "@/lib/eve-client";
import type { LinqJobCardThread } from "@/lib/goforay/linq-job-card-state";

/**
 * An iMessage thread maps to one eve session for as long as the thread lives,
 * so its history, and the per-call cost of re-reading it, only ever grows.
 * After this much silence the next message starts a fresh session instead;
 * workspace memory carries the stable facts across.
 */
export const LINQ_SESSION_IDLE_MS = 6 * 60 * 60_000;

const LINQ_SESSION_ACTIVITY_KEY = "linqSessionActivity";

const activitySchema = z.object({
  /** The deployment whose code this session runs. Absent before this existed. */
  buildId: z.string().optional(),
  lastActivityAt: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * The build currently answering, or undefined off Vercel.
 *
 * A session is a durable run, and a durable run executes the code of the
 * deployment that started it — so shipping a fix does not reach a thread that
 * is already talking. Recording the build with the session is what lets the
 * next message notice the difference.
 */
function currentLinqBuildId() {
  return env.VERCEL_DEPLOYMENT_ID;
}

/**
 * Whether this session is still running the build that is deployed now.
 * Unknown on either side counts as current: a thread from before this was
 * recorded must not be retired on a guess, and off Vercel there is no build
 * to compare against.
 */
export function isLinqSessionOnCurrentBuild(
  activity: LinqSessionActivity,
  buildId = currentLinqBuildId()
) {
  if (!buildId || !activity.buildId) return true;
  return activity.buildId === buildId;
}
const threadStateSchema = z.object({
  [LINQ_SESSION_ACTIVITY_KEY]: activitySchema,
});

export type LinqSessionActivity = z.infer<typeof activitySchema>;

export async function readLinqSessionActivity(
  thread: LinqJobCardThread
): Promise<LinqSessionActivity | undefined> {
  try {
    const parsed = threadStateSchema.safeParse(await thread.state);
    return parsed.success ? parsed.data[LINQ_SESSION_ACTIVITY_KEY] : undefined;
  } catch (error) {
    console.warn("[linq-session] activity state unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Records which session answered this thread and when. */
export async function rememberLinqSessionActivity(
  thread: LinqJobCardThread,
  // The channel's `send` returns the live session; tests stub it as void.
  session: { readonly id: string } | undefined,
  now = new Date(),
  buildId = currentLinqBuildId()
) {
  const sessionId = session?.id;
  if (!sessionId) return;
  try {
    await thread.setState({
      [LINQ_SESSION_ACTIVITY_KEY]: {
        ...(buildId ? { buildId } : {}),
        lastActivityAt: now.toISOString(),
        sessionId,
      } satisfies LinqSessionActivity,
    });
  } catch (error) {
    console.warn("[linq-session] could not persist session activity", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function isLinqSessionIdle(
  activity: LinqSessionActivity,
  now = new Date()
) {
  const last = Date.parse(activity.lastActivityAt);
  return Number.isFinite(last) && now.getTime() - last >= LINQ_SESSION_IDLE_MS;
}

/**
 * Retires the thread's session when it has gone stale, so the next `send`
 * starts a fresh one.
 *
 * Two things make a session stale. It has been quiet long enough that its
 * history costs more than it is worth, or it is running a build that is no
 * longer deployed — a durable run executes the code of the deployment that
 * started it, so without this a shipped fix never reaches a thread that is
 * already talking, and a candidate keeps hitting a bug that was fixed hours
 * ago.
 *
 * Neither reason overrides a worker parked on this candidate: an unfinished
 * execution keeps the session whatever else is true, because retiring it
 * would destroy a browser holding a filled form. That is safe to lean on
 * because the lease watchdog flips an abandoned run to `timed_out` within its
 * twenty-minute window, so a dead run cannot pin a thread forever.
 *
 * Never throws: a failed rollover just means the old session answers once more.
 */
export async function rollOverStaleLinqSession(
  thread: LinqJobCardThread,
  now = new Date(),
  buildId = currentLinqBuildId()
): Promise<"kept" | "none" | "rolled_over"> {
  const activity = await readLinqSessionActivity(thread);
  if (!activity) return "none";
  const idle = isLinqSessionIdle(activity, now);
  const staleBuild = !isLinqSessionOnCurrentBuild(activity, buildId);
  if (!idle && !staleBuild) return "kept";
  try {
    const unfinished = await hasUnfinishedApplicationExecution(
      activity.sessionId
    );
    if (unfinished) return "kept";
    const reason = staleBuild
      ? "The deployment this session started on has been replaced."
      : "Idle thread: starting a fresh session.";
    const result = await eveSessionClient()
      .sessions.attach(activity.sessionId)
      .reset({ reason });
    console.info("[linq-session] rollover", {
      idle_ms: now.getTime() - Date.parse(activity.lastActivityAt),
      previous_build_id: activity.buildId,
      previous_session_id: activity.sessionId,
      reason: staleBuild ? "stale_build" : "idle",
      status: result.status,
    });
    return "rolled_over";
  } catch (error) {
    console.error("[linq-session] rollover failed", {
      message: error instanceof Error ? error.message : String(error),
      session_id: activity.sessionId,
    });
    return "kept";
  }
}

/**
 * Context for a session that has no history of this thread: the applications
 * the workspace has tracked, newest first, with the URL each needs to be
 * retried. Without it, "resubmit" or "try Lambda again" after a rollover named
 * a posting the coordinator had no way to look up, and it answered as if it
 * had started the run.
 */
export function freshSessionApplicationsContext(
  executions: readonly {
    applyUrl: string;
    company: string;
    role: string;
    status: string;
    updatedAt: string;
  }[]
) {
  const tracked = executions.filter((execution) => execution.applyUrl !== "");
  if (tracked.length === 0) return undefined;
  const lines = tracked.map((execution) => {
    const label = [execution.role, execution.company]
      .filter((part) => part !== "")
      .join(" at ");
    return `- ${label || "untitled posting"}; status ${execution.status}; last update ${execution.updatedAt}; apply URL ${execution.applyUrl}`;
  });
  return [
    "This is a fresh session: the thread's earlier messages are not visible to you. Applications tracked for this candidate, newest first:",
    ...lines,
    'When the candidate refers to one of these (for example "resubmit", "try again", or the role or company name) without giving a URL, call start_application with that apply URL. A status of failed or timed_out is retryable and is neither posting_unavailable nor already_in_progress. Never say an application is being started or resubmitted unless start_application has returned in this turn.',
  ].join("\n");
}

/**
 * The fresh-session context for this candidate, or nothing when the lookup
 * fails or there is nothing tracked. Never throws: a slow or absent database
 * must not cost the candidate their turn.
 */
export async function trackedApplicationsForFreshSession(scope: AccessScope) {
  try {
    return freshSessionApplicationsContext(
      await listRecentApplicationExecutions(scope)
    );
  } catch (error) {
    console.warn("[linq-session] tracked applications unavailable", {
      message: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return undefined;
  }
}
