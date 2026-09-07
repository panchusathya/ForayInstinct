import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findRun: vi.fn<() => Promise<unknown>>(),
  forgetAnswers: vi.fn<() => Promise<void>>(),
  resumeHook: vi.fn<() => Promise<void>>(),
  runUntilPause:
    vi.fn<
      (_input: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(),
  submit:
    vi.fn<
      (_input: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(),
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
import { looksLikeVerificationCode } from "@/lib/application-runner/types";

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

  it("does not read an ordinary answer with a number in it as a code", async () => {
    // "10 years" to "Years of experience?" was typed into the code dialog.
    await continueApplication({
      answered: { "Years of experience?": "10 years" },
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeOtp"
    );
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).toMatchObject({
      resumeAnswered: { "Years of experience?": "10 years" },
    });
  });

  it("reads a lone answer as a code only when the run was waiting on one", async () => {
    mocks.findRun.mockResolvedValue({ ...run, pauseReason: "user_input" });
    await continueApplication({
      answered: { Code: "482913" },
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeOtp"
    );
    vi.clearAllMocks();
    mocks.findRun.mockResolvedValue({ ...run, pauseReason: "email_otp" });
    mocks.runUntilPause.mockResolvedValue({
      applyUrl,
      done: true,
      message: "Submitted",
    });
    await continueApplication({
      answered: { Code: "482913" },
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).toMatchObject({
      resumeOtp: "482913",
    });
  });

  it("knows a code's shape from an answer's", () => {
    for (const code of ["482 913", "7K3-9D2", "123456", "48291", "AB12 CD34"]) {
      expect(looksLikeVerificationCode(code)).toBe(true);
    }
    for (const answer of [
      "5 years",
      "10 years",
      "2 weeks",
      "Level 3",
      "Yes 1",
      "Boston MA 02110",
      "Tier 2 visa",
      "No",
      "ABCD EFGH",
    ]) {
      expect(looksLikeVerificationCode(answer)).toBe(false);
    }
  });
});

describe("a run that already ended", () => {
  it("returns the finished result on a second approval and touches nothing", async () => {
    // Nothing checked the run's status, so a second "yes" reached
    // submitApplication on the confirmation page, where the related-jobs
    // Apply buttons were the only submit-shaped controls left to click.
    mocks.findRun.mockResolvedValue({ ...run, status: "completed" });
    const result = await continueApplication({
      applyUrl,
      approved: true,
      scope,
    });
    expect(result).toMatchObject({ done: true, status: "completed" });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.runUntilPause).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });

  it("refuses to continue a run that failed or timed out", async () => {
    mocks.findRun.mockResolvedValue({ ...run, status: "timed_out" });
    const result = await continueApplication({
      answers: "Boston",
      applyUrl,
      approved: true,
      scope,
    });
    expect(result).toMatchObject({ status: "timed_out" });
    expect("message" in result ? result.message : "").toContain(
      "start_application"
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.runUntilPause).not.toHaveBeenCalled();
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

describe("a run whose browser is gone when the candidate answers", () => {
  const noBrowser = { ...run, browserSessionId: "" };

  it("fills again and submits once when the candidate approved", async () => {
    // The approval used to fall through to "Continue signal recorded" and do
    // nothing, forever; the candidate was asked to confirm again and again.
    mocks.findRun
      .mockResolvedValueOnce(noBrowser)
      .mockResolvedValueOnce({ ...run, browserSessionId: "browser-2" });
    mocks.runUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs approval: Analyst",
      pause: "approval",
    });
    mocks.submit.mockResolvedValue({
      applyUrl,
      done: true,
      message: "Submitted Analyst.",
    });
    const result = await continueApplication({
      applyUrl,
      approved: true,
      scope,
    });
    expect(mocks.runUntilPause).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit.mock.calls[0]?.[0]).toMatchObject({
      browserSessionId: "browser-2",
    });
    expect(result).toMatchObject({ done: true });
    expect("message" in result ? result.message : "").toContain(
      "filled again in a new one"
    );
  });

  it("stops at a question the refill raises rather than submitting", async () => {
    mocks.findRun.mockResolvedValue(noBrowser);
    mocks.runUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs input: Are you authorized to work in the US?",
      pause: "user_input",
    });
    const result = await continueApplication({
      applyUrl,
      approved: true,
      scope,
    });
    expect(result).toMatchObject({ pause: "user_input" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not drop answers sent to a run with no browser", async () => {
    mocks.findRun.mockResolvedValue(noBrowser);
    const result = await continueApplication({
      answered: { "Are you authorized to work in the US?": "Yes" },
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause).toHaveBeenCalledTimes(1);
    expect(mocks.runUntilPause.mock.calls[0]?.[0]).toMatchObject({
      resumeAnswered: { "Are you authorized to work in the US?": "Yes" },
    });
    expect(result).toMatchObject({ pause: "approval" });
  });

  it("treats a cross-domain death as a lost browser, as the gateway reports it", async () => {
    const hopped = Object.assign(
      new Error("Session died on a cross-domain hop"),
      {
        error: {
          code: "cross_domain_navigation",
          domains: ["a.example", "b.example"],
        },
        status: 410,
      }
    );
    mocks.runUntilPause.mockRejectedValueOnce(hopped).mockResolvedValueOnce({
      applyUrl,
      message: "Needs approval: Analyst",
      pause: "approval",
    });
    const result = await continueApplication({
      answers: "Boston",
      applyUrl,
      scope,
    });
    expect(mocks.runUntilPause).toHaveBeenCalledTimes(2);
    expect(mocks.updateRun).toHaveBeenCalledWith({
      browserSessionId: "",
      executionId: "exec-1",
    });
    expect(result).toMatchObject({ pause: "approval" });
  });
});
