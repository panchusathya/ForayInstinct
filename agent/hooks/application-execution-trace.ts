import { defineHook } from "eve/hooks";
import { browserGatewayModel } from "@/lib/model-config";
import {
  attachApplicationWorker,
  createApplicationExecution,
} from "@/db/services/application-executions";
import { parseApplicationIdentity } from "@/lib/application-execution";
import { scopeFromPrincipal } from "@/lib/access-scope";

export default defineHook({
  events: {
    async "actions.requested"(event, ctx) {
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (!caller) return;
      try {
        for (const action of event.data.actions) {
          if (action.kind !== "subagent-call" || action.name !== "worker")
            continue;
          const message =
            typeof action.input.message === "string"
              ? action.input.message
              : "";
          await createApplicationExecution({
            callId: action.callId,
            identity: parseApplicationIdentity(message),
            model: browserGatewayModel,
            rootSessionId: ctx.session.id,
            scope: scopeFromPrincipal(caller),
          });
        }
      } catch (error) {
        console.error("[application-execution] dispatch trace failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    },
    async "subagent.called"(event, ctx) {
      if (event.data.name !== "worker") return;
      try {
        await attachApplicationWorker({
          callId: event.data.callId,
          rootSessionId: ctx.session.id,
          workerSessionId: event.data.childSessionId,
        });
      } catch (error) {
        console.error("[application-execution] child trace failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    },
  },
});
