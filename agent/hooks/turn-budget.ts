import { defineHook } from "eve/hooks";
import {
  cancelRunawayTurn,
  clearTurnBudget,
  recordTurnStep,
  turnBudgetExceeded,
} from "../lib/turn-budget";

/**
 * Bounds one coordinator turn. eve exposes no per-turn limit, only a lifetime
 * session cap, so the hook sums provider-reported usage per turn and cancels
 * a turn that has clearly stopped converging.
 */
export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      try {
        const totals = await recordTurnStep({
          inputTokens: event.data.usage?.inputTokens ?? 0,
          sessionId: ctx.session.id,
          stepIndex: event.data.stepIndex,
          turnId: event.data.turnId,
        });
        const reason = turnBudgetExceeded(totals);
        if (!reason) return;
        await cancelRunawayTurn({
          reason,
          sessionId: ctx.session.id,
          totals,
          turnId: event.data.turnId,
        });
      } catch (error) {
        // A guard must never be the thing that fails a healthy turn.
        console.error("[turn-budget] step accounting failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    },
    async "turn.cancelled"(event, ctx) {
      await clearTurnBudget(ctx.session.id, event.data.turnId).catch(
        () => undefined
      );
    },
    async "turn.completed"(event, ctx) {
      await clearTurnBudget(ctx.session.id, event.data.turnId).catch(
        () => undefined
      );
    },
    async "turn.failed"(event, ctx) {
      await clearTurnBudget(ctx.session.id, event.data.turnId).catch(
        () => undefined
      );
    },
  },
});
