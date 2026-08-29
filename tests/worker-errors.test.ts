import { describe, expect, it, vi } from "vitest";
import workerErrors from "../agent/hooks/worker-errors";
import workerSubagentErrors from "../agent/subagents/worker/hooks/worker-errors";

describe("worker error logging", () => {
  it("logs turn.failed without throwing", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = workerErrors.events?.["turn.failed"];
    if (!handler) throw new Error("turn.failed handler is missing.");

    expect(() =>
      handler(
        {
          data: {
            code: "tool_error",
            message: "Playwright execution exceeded 30 seconds.",
            turnId: "turn-1",
          },
        } as never,
        {
          session: { id: "session-1", parent: { rootSessionId: "root-1" } },
        } as never
      )
    ).not.toThrow();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("worker.turn_failed")
    );
    expect(error.mock.calls[0]?.[0]).toContain(
      "Playwright execution exceeded 30 seconds."
    );
    error.mockRestore();
  });

  it("ignores successful action results", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = workerErrors.events?.["action.result"];
    if (!handler) throw new Error("action.result handler is missing.");

    handler(
      {
        data: { result: { isError: false, output: { ok: true } }, turnId: "t" },
      } as never,
      { session: { id: "session-1" } } as never
    );

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("logs a structured worker tool error", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { logWorkerToolError } =
      await import("../agent/lib/worker-tool-error");

    logWorkerToolError({
      error: new Error("Playwright execution exceeded 30 seconds."),
      sessionId: "browser-1",
      toolName: "execute_playwright_code",
    });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("worker.tool_error")
    );
    expect(error.mock.calls[0]?.[0]).toContain("execute_playwright_code");
    expect(error.mock.calls[0]?.[0]).toContain(
      "Playwright execution exceeded 30 seconds."
    );
    error.mockRestore();
  });

  it("subscribes the worker to turn.failed", () => {
    expect(workerSubagentErrors.events?.["turn.failed"]).toEqual(
      expect.any(Function)
    );
    expect(workerSubagentErrors.events?.["action.result"]).toEqual(
      expect.any(Function)
    );
  });
});
