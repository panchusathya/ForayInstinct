import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "actions.requested"(event) {
      try {
        for (const action of event.data.actions) {
          if (action.kind !== "subagent-call" || action.name !== "worker")
            continue;
          console.error(
            "[application-execution] worker subagent is retired; use start_application",
            { parent_call_id: action.callId }
          );
        }
      } catch (error) {
        console.error("[application-execution] dispatch trace failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    },
  },
});
