import { afterEach, describe, expect, it, vi } from "vitest";
import actionResultErrors from "../agent/hooks/action-result-errors";

type ActionResultHandler = NonNullable<
  NonNullable<typeof actionResultErrors.events>["action.result"]
>;

function resultEvent(result: Record<string, unknown>) {
  // oxlint-disable typescript/no-unsafe-type-assertion -- The handler reads only data.result and data.turnId.
  return {
    data: {
      result,
      sequence: 0,
      status: "completed",
      stepIndex: 2,
      turnId: "turn-1",
    },
    meta: { id: "evt_1" },
    type: "action.result",
  } as unknown as Parameters<ActionResultHandler>[0];
  // oxlint-enable typescript/no-unsafe-type-assertion
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The hook reads only session.id.
const context = {
  session: { id: "session-1" },
} as unknown as Parameters<ActionResultHandler>[1];

const handler = actionResultErrors.events?.["action.result"];
if (!handler) throw new Error("action.result handler missing");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failed tool results reach the deployment logs", () => {
  it("logs the tool, the call, the turn and the first line of the error", async () => {
    // A start_application that threw before its own logging (an auth check,
    // a schema rejection) used to be visible to the model alone, so a turn
    // that said it was applying could not be told from one that never called
    // the tool.
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await handler(
      resultEvent({
        callId: "call-1",
        isError: true,
        kind: "tool-result",
        output: "An authenticated user is required.\nat execute (...)",
        toolName: "start_application",
      }),
      context
    );
    expect(errorSpy).toHaveBeenCalledWith("[tool] failed", {
      call_id: "call-1",
      error: "An authenticated user is required.",
      session_id: "session-1",
      tool_name: "start_application",
      turn_id: "turn-1",
    });
  });

  it("stays quiet for a successful tool, a subagent result, and a structured error it can still describe", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await handler(
      resultEvent({
        callId: "call-2",
        kind: "tool-result",
        output: { status: "working" },
        toolName: "start_application",
      }),
      context
    );
    await handler(
      resultEvent({ callId: "call-3", kind: "subagent-result", output: {} }),
      context
    );
    expect(errorSpy).not.toHaveBeenCalled();

    await handler(
      resultEvent({
        callId: "call-4",
        isError: true,
        kind: "tool-result",
        output: { message: "x".repeat(400) },
        toolName: "continue_application",
      }),
      context
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // A structured error is serialized and cut to 300 characters.
    const details: unknown = errorSpy.mock.calls[0]?.[1];
    expect(details).toMatchObject({ tool_name: "continue_application" });
    const errorText =
      typeof details === "object" && details !== null && "error" in details
        ? details.error
        : undefined;
    expect(errorText).toMatch(/^\{"message":"x{288}$/u);
  });
});
