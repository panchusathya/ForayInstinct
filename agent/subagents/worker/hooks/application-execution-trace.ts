import { defineHook, type HookContext } from "eve/hooks";
import { updateApplicationExecutionForWorker } from "@/db/services/application-executions";
import { safeErrorCode } from "@/lib/application-execution";

type WorkerUpdate = Omit<
  Parameters<typeof updateApplicationExecutionForWorker>[0],
  "eventId" | "eventType" | "parentCallId" | "rootSessionId" | "workerSessionId"
>;

function parentCoordinates(ctx: HookContext) {
  const parent = ctx.session.parent;
  return parent
    ? { parentCallId: parent.callId, rootSessionId: parent.rootSessionId }
    : undefined;
}

function logTraceFailure(stage: string, error: unknown) {
  console.error("[application-execution] worker trace failed", {
    error: error instanceof Error ? error.message : "unknown",
    stage,
  });
}

async function update(
  event: { meta: { id: string }; type: string },
  ctx: HookContext,
  input: WorkerUpdate
) {
  const parent = parentCoordinates(ctx);
  if (!parent) return;
  await updateApplicationExecutionForWorker({
    ...input,
    ...parent,
    eventId: event.meta.id,
    eventType: event.type,
    workerSessionId: ctx.session.id,
  });
}

export default defineHook({
  events: {
    async "session.started"() {
      throw new Error(
        "The worker subagent is retired. Use start_application for job filling."
      );
    },
    async "turn.started"(event, ctx) {
      try {
        await update(event, ctx, {
          stage: "worker",
          startActive: true,
          status: "running",
          turnId: event.data.turnId,
        });
      } catch (error) {
        logTraceFailure("turn.started", error);
      }
    },
    async "actions.requested"(event, ctx) {
      try {
        for (const action of event.data.actions) {
          await update(
            { ...event, meta: { id: `${event.meta.id}:${action.callId}` } },
            ctx,
            {
              stage: "tool",
              status: "running",
              toolName:
                action.kind === "tool-call"
                  ? action.toolName
                  : action.kind === "subagent-call" ||
                      action.kind === "remote-agent-call"
                    ? action.name
                    : undefined,
            }
          );
        }
      } catch (error) {
        logTraceFailure("actions.requested", error);
      }
    },
    async "action.result"(event, ctx) {
      try {
        await update(event, ctx, {
          errorCode:
            event.data.status === "completed"
              ? undefined
              : safeErrorCode(event.data.error),
          stage: "tool.result",
          status: "running",
        });
      } catch (error) {
        logTraceFailure("action.result", error);
      }
    },
    async "input.requested"(event, ctx) {
      try {
        await update(event, ctx, { stage: "blocker", status: "waiting" });
      } catch (error) {
        logTraceFailure("input.requested", error);
      }
    },
    async "result.completed"(event, ctx) {
      try {
        await update(event, ctx, { stage: "result", status: "completed" });
      } catch (error) {
        logTraceFailure("result.completed", error);
      }
    },
    async "session.waiting"(event, ctx) {
      try {
        await update(event, ctx, { stage: "waiting", status: "waiting" });
      } catch (error) {
        logTraceFailure("session.waiting", error);
      }
    },
    async "turn.cancelled"(event, ctx) {
      try {
        await update(event, ctx, {
          stage: "cancelled",
          status: "failed",
          errorCode: "cancelled",
        });
      } catch (error) {
        logTraceFailure("turn.cancelled", error);
      }
    },
    async "turn.failed"(event, ctx) {
      try {
        await update(event, ctx, {
          stage: "failed",
          status: "failed",
          errorCode: safeErrorCode(event.data),
        });
      } catch (error) {
        logTraceFailure("turn.failed", error);
      }
    },
  },
});
