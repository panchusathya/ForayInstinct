import { defineHook } from "eve/hooks";

/**
 * Logs every authored tool call that failed. eve hands the error to the model
 * and nothing else, so a tool that threw before its own logging (an auth
 * check, a schema rejection) left no trace in the deployment logs, and a turn
 * that claimed to be applying could not be told apart from one that never
 * called the tool.
 */
export default defineHook({
  events: {
    "action.result"(event, ctx) {
      try {
        const { result } = event.data;
        if (result.kind !== "tool-result" || result.isError !== true) return;
        console.error("[tool] failed", {
          call_id: result.callId,
          error: describeOutput(result.output),
          session_id: ctx.session.id,
          tool_name: result.toolName,
          turn_id: event.data.turnId,
        });
      } catch (error) {
        // An observer must never be the thing that fails a turn.
        console.error("[tool] failure logging failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    },
  },
});

/** The first line of the error, however the runtime shaped it. */
function describeOutput(output: unknown) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const [firstLine = ""] = text.split("\n");
  return firstLine.slice(0, 300);
}
