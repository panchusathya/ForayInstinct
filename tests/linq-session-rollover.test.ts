import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasUnfinishedApplicationExecution: vi.fn<() => Promise<boolean>>(),
  reset: vi.fn<() => Promise<{ status: string }>>(),
}));

vi.mock("@/db/services/application-executions", () => ({
  hasUnfinishedApplicationExecution: mocks.hasUnfinishedApplicationExecution,
}));
vi.mock("@/lib/eve-client", () => ({
  eveSessionClient: () => ({
    sessions: { attach: () => ({ reset: mocks.reset }) },
  }),
}));

import {
  LINQ_SESSION_IDLE_MS,
  isLinqSessionIdle,
  readLinqSessionActivity,
  rememberLinqSessionActivity,
  rollOverIdleLinqSession,
} from "@/agent/lib/linq-session-rollover";

function fakeThread(initial: Record<string, unknown> = {}) {
  let state: Record<string, unknown> = initial;
  return {
    get state() {
      return Promise.resolve(state);
    },
    setState: vi.fn<
      (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
    >((patch) => {
      state = { ...state, ...patch };
      return Promise.resolve(state);
    }),
  };
}

const now = new Date("2026-09-02T12:00:00.000Z");
const longAgo = new Date(now.getTime() - LINQ_SESSION_IDLE_MS - 1);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasUnfinishedApplicationExecution.mockResolvedValue(false);
  mocks.reset.mockResolvedValue({ status: "reset" });
});

describe("Linq idle session rollover", () => {
  it("remembers which session answered the thread and when", async () => {
    const thread = fakeThread();
    await rememberLinqSessionActivity(thread, { id: "session-1" }, now);
    expect(await readLinqSessionActivity(thread)).toEqual({
      lastActivityAt: now.toISOString(),
      sessionId: "session-1",
    });
    // The channel's send mock returns nothing in tests; a missing id is a no-op.
    await rememberLinqSessionActivity(fakeThread(), undefined, now);
  });

  it("treats six quiet hours as idle", () => {
    const activity = { lastActivityAt: longAgo.toISOString(), sessionId: "s" };
    expect(isLinqSessionIdle(activity, now)).toBe(true);
    expect(
      isLinqSessionIdle(
        {
          ...activity,
          lastActivityAt: new Date(now.getTime() - 60_000).toISOString(),
        },
        now
      )
    ).toBe(false);
  });

  it("retires an idle session so the next message starts fresh", async () => {
    const thread = fakeThread();
    await rememberLinqSessionActivity(thread, { id: "session-1" }, longAgo);
    expect(await rollOverIdleLinqSession(thread, now)).toBe("rolled_over");
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("keeps a recent session, an unknown thread, and a session with a parked worker", async () => {
    expect(await rollOverIdleLinqSession(fakeThread(), now)).toBe("none");

    const recent = fakeThread();
    await rememberLinqSessionActivity(recent, { id: "session-1" }, now);
    expect(await rollOverIdleLinqSession(recent, now)).toBe("kept");

    // A worker waiting on this candidate's approval must still be reachable
    // when they finally reply, however long that takes.
    mocks.hasUnfinishedApplicationExecution.mockResolvedValueOnce(true);
    const parked = fakeThread();
    await rememberLinqSessionActivity(parked, { id: "session-1" }, longAgo);
    expect(await rollOverIdleLinqSession(parked, now)).toBe("kept");
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("never blocks the inbound message when the reset fails", async () => {
    mocks.reset.mockRejectedValueOnce(new Error("offline"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const thread = fakeThread();
    await rememberLinqSessionActivity(thread, { id: "session-1" }, longAgo);
    expect(await rollOverIdleLinqSession(thread, now)).toBe("kept");
    errorSpy.mockRestore();
  });

  it("runs before every inbound send in the Linq channel", () => {
    const channel = readFileSync("agent/channels/linq-v2.ts", "utf8");
    expect(channel.match(/rollOverIdleLinqSession\(thread\)/gu)).toHaveLength(
      2
    );
    expect(
      channel.match(/rememberLinqSessionActivity\(thread, session\)/gu)
    ).toHaveLength(3);
    expect(channel).toContain(
      'async "input.requested"(event, context, session)'
    );
  });
});
