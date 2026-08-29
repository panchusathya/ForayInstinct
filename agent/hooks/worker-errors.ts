import { defineHook } from "eve/hooks";
import { logWorkerRuntimeEvent } from "../lib/worker-tool-error";

export default defineHook({
  events: {
    "action.result"(event, ctx) {
      const result = event.data.result;
      if (!isErrorResult(result)) return;
      logWorkerRuntimeEvent({
        kind: "worker.action_result",
        result,
        sessionId: ctx.session.id,
        parentSessionId: ctx.session.parent?.rootSessionId,
        turnId: event.data.turnId,
      });
    },
    "step.failed"(event, ctx) {
      logWorkerRuntimeEvent({
        code: event.data.code,
        kind: "worker.step_failed",
        message: event.data.message,
        sessionId: ctx.session.id,
        parentSessionId: ctx.session.parent?.rootSessionId,
        turnId: event.data.turnId,
      });
    },
    "turn.failed"(event, ctx) {
      logWorkerRuntimeEvent({
        code: event.data.code,
        kind: "worker.turn_failed",
        message: event.data.message,
        sessionId: ctx.session.id,
        parentSessionId: ctx.session.parent?.rootSessionId,
        turnId: event.data.turnId,
      });
    },
    "subagent.completed"(event, ctx) {
      if (!isFailedSubagent(event.data)) return;
      logWorkerRuntimeEvent({
        kind: "worker.subagent_completed",
        result: event.data,
        sessionId: ctx.session.id,
        parentSessionId: ctx.session.parent?.rootSessionId,
      });
    },
  },
});

function isErrorResult(result: unknown) {
  if (!result || typeof result !== "object") return false;
  return (result as { isError?: unknown }).isError === true;
}

function isFailedSubagent(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const status = (result as { status?: unknown }).status;
  return status === "error" || status === "failed" || status === "failure";
}
