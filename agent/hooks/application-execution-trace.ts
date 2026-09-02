import { defineHook } from "eve/hooks";
import { browserGatewayModel } from "@/lib/model-config";
import {
  attachApplicationWorker,
  createApplicationExecution,
} from "@/db/services/application-executions";
import {
  attachApplicationLeaseWorker,
  claimApplicationLease,
} from "@/db/services/application-leases";
import {
  executionId,
  parseApplicationIdentity,
} from "@/lib/application-execution";
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
          const identity = parseApplicationIdentity(message);
          const scope = scopeFromPrincipal(caller);
          await createApplicationExecution({
            callId: action.callId,
            identity,
            model: browserGatewayModel,
            rootSessionId: ctx.session.id,
            scope,
          });
          const agentId =
            typeof action.input.agentId === "string"
              ? action.input.agentId.trim()
              : "";
          if (agentId !== "") continue;
          const claim = await claimApplicationLease({
            applyUrl: identity.applyUrl,
            executionId: executionId(ctx.session.id, action.callId),
            rootSessionId: ctx.session.id,
            scope,
          });
          if (claim.status === "already_in_progress") {
            console.info("[application-execution] duplicate dispatch blocked", {
              apply_url: claim.applyUrl,
              existing_execution_id: claim.existingExecutionId,
              parent_call_id: action.callId,
            });
          }
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
        await attachApplicationLeaseWorker({
          executionId: executionId(ctx.session.id, event.data.callId),
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
