import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  countRecentApplicationExecutionEvents: vi.fn<() => Promise<number>>(),
  respond: vi.fn<(responses: unknown) => Promise<unknown>>(),
}));

vi.mock("@/db/services/application-executions", () => ({
  countRecentApplicationExecutionEvents:
    mocks.countRecentApplicationExecutionEvents,
}));
vi.mock("@/lib/eve-client", () => ({
  eveSessionClient: () => ({
    sessions: { attach: () => ({ respond: mocks.respond }) },
  }),
}));

import {
  renderInputRequestText,
  resolveSessionLimitPrompt,
  sessionLimitRequests,
} from "@/agent/lib/linq-input-requests";

const limitRequest = {
  kind: "session-limit",
  options: [
    { id: "continue", label: "Approve" },
    { id: "stop", label: "Stop" },
  ],
  prompt:
    "This session has hit the input-token limit (1M) per session. This is a guardrail against defective long-running sessions. If session activity looks fine, just approve to keep going.",
  requestId: "session-1:limit:input:1000001",
};
const question = {
  kind: "question",
  options: [
    { id: "yes", label: "Yes, send it" },
    { id: "no", label: "No" },
  ],
  prompt: "Send the email to the recruiter?",
  requestId: "req-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countRecentApplicationExecutionEvents.mockResolvedValue(0);
  mocks.respond.mockResolvedValue({ status: "accepted" });
});

describe("Linq input requests", () => {
  it("separates eve's budget guardrail from questions for the candidate", () => {
    expect(sessionLimitRequests([limitRequest, question])).toEqual([
      limitRequest,
    ]);
  });

  it("approves a fresh budget when the run looks healthy", async () => {
    await expect(
      resolveSessionLimitPrompt({
        requests: [limitRequest],
        sessionId: "session-1",
      })
    ).resolves.toBe("approved");
    expect(mocks.respond).toHaveBeenCalledWith([
      { optionId: "continue", requestId: limitRequest.requestId },
    ]);
  });

  it("stops a run whose trace shows duplicate workers in the last hour", async () => {
    mocks.countRecentApplicationExecutionEvents.mockResolvedValueOnce(2);
    await expect(
      resolveSessionLimitPrompt({
        requests: [limitRequest],
        sessionId: "session-1",
      })
    ).resolves.toBe("stopped");
    expect(mocks.respond).toHaveBeenCalledWith([
      { optionId: "stop", requestId: limitRequest.requestId },
    ]);
  });

  it("approves when the health check itself is unavailable", async () => {
    mocks.countRecentApplicationExecutionEvents.mockRejectedValueOnce(
      new Error("db down")
    );
    await expect(
      resolveSessionLimitPrompt({
        requests: [limitRequest],
        sessionId: "session-1",
      })
    ).resolves.toBe("approved");
  });

  it("renders a candidate question as numbered plain text", () => {
    expect(renderInputRequestText(question)).toBe(
      [
        "Send the email to the recruiter?",
        "1. Yes, send it",
        "2. No",
        "reply with the number or the word.",
      ].join("\n")
    );
    expect(renderInputRequestText({ ...question, options: undefined })).toBe(
      question.prompt
    );
  });
});
