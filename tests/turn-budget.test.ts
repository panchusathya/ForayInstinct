import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TurnBudget from "@/agent/lib/turn-budget";

const mocks = vi.hoisted(() => ({
  cancelRunawayTurn: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/agent/lib/turn-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof TurnBudget>();
  return { ...actual, cancelRunawayTurn: mocks.cancelRunawayTurn };
});

import turnBudget from "../agent/hooks/turn-budget";
import {
  TURN_INPUT_TOKEN_LIMIT,
  TURN_STEP_LIMIT,
  clearTurnBudget,
  recordTurnStep,
  turnBudgetExceeded,
} from "../agent/lib/turn-budget";

type StepCompletedHandler = NonNullable<
  NonNullable<typeof turnBudget.events>["step.completed"]
>;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await clearTurnBudget("session-1", "turn-1");
});

function stepEvent(stepIndex: number, inputTokens: number) {
  // oxlint-disable typescript/no-unsafe-type-assertion -- The handler reads only turnId, stepIndex, and usage.
  return {
    data: {
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex,
      turnId: "turn-1",
      usage: { inputTokens, outputTokens: 50 },
    },
    meta: { id: `evt_${String(stepIndex)}` },
  } as Parameters<StepCompletedHandler>[0];
  // oxlint-enable typescript/no-unsafe-type-assertion
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The hook reads only session.id.
const context = {
  session: { id: "session-1" },
} as unknown as Parameters<StepCompletedHandler>[1];

describe("turn budget", () => {
  it("sums input tokens per turn and treats a retried step as one step", async () => {
    await recordTurnStep({
      inputTokens: 1_000,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    });
    await recordTurnStep({
      inputTokens: 2_000,
      sessionId: "session-1",
      stepIndex: 1,
      turnId: "turn-1",
    });
    // A durable-step retry re-emits the same step index; last write wins.
    const totals = await recordTurnStep({
      inputTokens: 2_500,
      sessionId: "session-1",
      stepIndex: 1,
      turnId: "turn-1",
    });
    expect(totals).toEqual({ inputTokens: 3_500, steps: 2 });
    expect(turnBudgetExceeded(totals)).toBeUndefined();
  });

  it("names the budget a turn has blown", () => {
    expect(
      turnBudgetExceeded({ inputTokens: 0, steps: TURN_STEP_LIMIT + 1 })
    ).toBe("steps");
    expect(
      turnBudgetExceeded({ inputTokens: TURN_INPUT_TOKEN_LIMIT + 1, steps: 1 })
    ).toBe("input_tokens");
    expect(
      turnBudgetExceeded({
        inputTokens: TURN_INPUT_TOKEN_LIMIT,
        steps: TURN_STEP_LIMIT,
      })
    ).toBeUndefined();
  });

  it("cancels the turn once a step pushes it over the input budget", async () => {
    const handler = turnBudget.events?.["step.completed"];
    expect(handler).toBeDefined();

    await handler?.(stepEvent(0, TURN_INPUT_TOKEN_LIMIT - 10), context);
    expect(mocks.cancelRunawayTurn).not.toHaveBeenCalled();

    await handler?.(stepEvent(1, 20), context);
    expect(mocks.cancelRunawayTurn).toHaveBeenCalledWith({
      reason: "input_tokens",
      sessionId: "session-1",
      totals: { inputTokens: TURN_INPUT_TOKEN_LIMIT + 10, steps: 2 },
      turnId: "turn-1",
    });
  });

  it("cancels a turn that loops past the step limit even when calls are cheap", async () => {
    const handler = turnBudget.events?.["step.completed"];
    for (let step = 0; step <= TURN_STEP_LIMIT; step += 1) {
      await handler?.(stepEvent(step, 100), context);
    }
    expect(mocks.cancelRunawayTurn).toHaveBeenCalledTimes(1);
    expect(mocks.cancelRunawayTurn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "steps" })
    );
  });

  it("never fails a healthy turn when accounting breaks", async () => {
    mocks.cancelRunawayTurn.mockRejectedValueOnce(new Error("network"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = turnBudget.events?.["step.completed"];

    await expect(
      handler?.(stepEvent(0, TURN_INPUT_TOKEN_LIMIT + 1), context)
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
