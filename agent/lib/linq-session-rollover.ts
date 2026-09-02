import { z } from "zod";
import { hasUnfinishedApplicationExecution } from "@/db/services/application-executions";
import { eveSessionClient } from "@/lib/eve-client";
import type { LinqJobCardThread } from "@/lib/goforay/linq-job-card-state";

/**
 * An iMessage thread maps to one eve session for as long as the thread lives,
 * so its history, and the per-call cost of re-reading it, only ever grows, and
 * a deploy never reaches it. After this much silence the next message starts
 * a fresh session instead; workspace memory carries the stable facts across.
 */
export const LINQ_SESSION_IDLE_MS = 6 * 60 * 60_000;

const LINQ_SESSION_ACTIVITY_KEY = "linqSessionActivity";

const activitySchema = z.object({
  lastActivityAt: z.string().min(1),
  sessionId: z.string().min(1),
});
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
  now = new Date()
) {
  const sessionId = session?.id;
  if (!sessionId) return;
  try {
    await thread.setState({
      [LINQ_SESSION_ACTIVITY_KEY]: {
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
 * Retires the thread's session when it has been idle long enough and no
 * worker is parked waiting for this candidate. The next `send` on the thread
 * then starts a fresh session. Never throws: a failed rollover just means the
 * old session answers one more time.
 */
export async function rollOverIdleLinqSession(
  thread: LinqJobCardThread,
  now = new Date()
): Promise<"kept" | "none" | "rolled_over"> {
  const activity = await readLinqSessionActivity(thread);
  if (!activity) return "none";
  if (!isLinqSessionIdle(activity, now)) return "kept";
  try {
    const unfinished = await hasUnfinishedApplicationExecution(
      activity.sessionId
    );
    if (unfinished) return "kept";
    const result = await eveSessionClient()
      .sessions.attach(activity.sessionId)
      .reset({ reason: "Idle thread: starting a fresh session." });
    console.info("[linq-session] idle rollover", {
      idle_ms: now.getTime() - Date.parse(activity.lastActivityAt),
      previous_session_id: activity.sessionId,
      status: result.status,
    });
    return "rolled_over";
  } catch (error) {
    console.error("[linq-session] idle rollover failed", {
      message: error instanceof Error ? error.message : String(error),
      session_id: activity.sessionId,
    });
    return "kept";
  }
}
