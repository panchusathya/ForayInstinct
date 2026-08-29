import { defineHook } from "eve/hooks";
import {
  clearWorkerCancellationTurn,
  recordWorkerCancellationTurn,
} from "../lib/worker-cancellation-delivery";

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      await recordWorkerCancellationTurn(
        ctx.session.id,
        event.data.turnId,
        event.data.message
      );
    },
    async "turn.cancelled"(event, ctx) {
      await clearWorkerCancellationTurn(ctx.session.id, event.data.turnId);
    },
    async "turn.completed"(event, ctx) {
      await clearWorkerCancellationTurn(ctx.session.id, event.data.turnId);
    },
    async "turn.failed"(event, ctx) {
      await clearWorkerCancellationTurn(ctx.session.id, event.data.turnId);
    },
  },
});
