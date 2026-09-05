import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findRun: vi.fn<() => Promise<unknown>>(),
  forgetAnswers: vi.fn<() => Promise<void>>(),
  resumeHook: vi.fn<() => Promise<void>>(),
  runUntilPause:
    vi.fn<
      (_input: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(),
  submit: vi.fn<() => Promise<Record<string, unknown>>>(),
  updateRun: vi.fn<(_input: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("@/db/services/application-executions", () => ({
  findApplicationRun: mocks.findRun,
  updateApplicationRun: mocks.updateRun,
}));

vi.mock("@/lib/application-runner/run", () => ({
  runApplicationUntilPause: mocks.runUntilPause,
}));

vi.mock("@/lib/application-runner/fill", () => ({
  submitApplication: mocks.submit,
}));

vi.mock("@/lib/application-runner/workflow", () => ({
  resumeApplicationHook: mocks.resumeHook,
}));

vi.mock("@/lib/application-runner/browser", () => ({
  closeApplicationBrowser: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/manager/server/application-answers", () => ({
  forgetRunAnswers: mocks.forgetAnswers,
}));

import { continueApplication } from "@/lib/application-runner/continue";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const applyUrl = "https://job-boards.greenhouse.io/doordashusa/jobs/1";
const run = {
  applyUrl,
  browserSessionId: "browser-1",
  company: "DoorDash",
  id: "exec-1",
  pauseReason: "user_input",
  role: "Analyst",
  rootSessionId: "root-1",
  status: "waiting",
  workflowRunId: "inline:exec-1",
};
const gone = Object.assign(new Error("Session browser-1 is gone"), {
  error: { code: "session_gone" },
  status: 410,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue(run);
  mocks.resumeHook.mockResolvedValue(undefined);
  mocks.updateRun.mockResolvedValue(undefined);
  mocks.forgetAnswers.mockResolvedValue(undefined);
  mocks.runUntilPause.mockResolvedValue({
    applyUrl,
    message: "Needs approval: Analyst",
    pause: "approval",
  });
});

describe("a code sent back to a waiting run", () => {
  it("routes a bare code typed as an answer to the code entry, whatever the last pause was", async () => {
    // The pause a Greenhouse code dialog produced was a plain "blocked
    // submit", so the candidate's code came back as free text and was
    // treated as an answer to the form.
    await continueApplication({ answers: "482913", applyUrl, scope });
    expect(mocks.runUntilPause).toHaveBeenCalledTimes(1);
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).toMatchObject({
      resumeAnswers: "482913",
      resumeOtp: "482913",
    });
  });

  it("sends a code from the otp field on its own", async () => {
    await continueApplication({ applyUrl, otp: " 482 913 ", scope });
    const input = mocks.runUntilPause.mock.calls[0]?.[0];
    expect(input).toMatchObject({ resumeOtp: "482 913" });
    expect(input).not.toHaveProperty("resumeAnswers");
  });

  it("does not mistake a word for a code", async () => {
    await continueApplication({
      answered: { "Have you worked at DoorDash?*": "No" },
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeOtp"
    );
  });
});

describe("a browser that died between rounds", () => {
  it("opens a fresh one and fills the form again instead of throwing", async () => {
    // Brightdata dropped the browser between the review screenshot and the
    // approval; the tool threw session_gone twice and the agent started over.
    mocks.submit.mockRejectedValue(gone);
    const result = await continueApplication({
      applyUrl,
      approved: true,
      scope,
    });
    expect(mocks.updateRun).toHaveBeenCalledWith({
      browserSessionId: "",
      executionId: "exec-1",
    });
    expect(mocks.runUntilPause).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pause: "approval" });
    expect("message" in result ? result.message : "").toContain(
      "browser session had expired"
    );
  });

  it("lets any other failure through", async () => {
    mocks.submit.mockRejectedValue(new Error("upstream timeout"));
    await expect(
      continueApplication({ applyUrl, approved: true, scope })
    ).rejects.toThrow(/upstream timeout/u);
    expect(mocks.runUntilPause).not.toHaveBeenCalled();
  });
});
