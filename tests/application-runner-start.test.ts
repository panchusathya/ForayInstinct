import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimApplicationLease: vi.fn<() => Promise<Record<string, unknown>>>(),
  createApplicationExecution: vi.fn<() => Promise<void>>(),
  findApplicationRun: vi.fn<
    () => Promise<
      | undefined
      | {
          browserSessionId?: string;
          id: string;
          status: string;
          workflowRunId: string;
        }
    >
  >(),
  readCandidateProfile: vi.fn<() => Promise<Record<string, unknown>>>(),
  readOrImportDefaultResume:
    vi.fn<() => Promise<Record<string, unknown> | undefined>>(),
  runApplicationUntilPause: vi.fn<() => Promise<Record<string, unknown>>>(),
  updateApplicationRun:
    vi.fn<
      (_input: {
        browserSessionId?: string;
        pauseReason?: string | null;
        status?: string;
        workflowRunId?: string;
      }) => Promise<void>
    >(),
}));

vi.mock("@/db/services/application-executions", () => ({
  createApplicationExecution: mocks.createApplicationExecution,
  findApplicationRun: mocks.findApplicationRun,
  updateApplicationRun: mocks.updateApplicationRun,
}));

vi.mock("@/db/services/application-leases", () => ({
  claimApplicationLease: mocks.claimApplicationLease,
}));

vi.mock("@/db/services/candidate-profile", () => ({
  readCandidateProfile: mocks.readCandidateProfile,
}));

vi.mock("@/db/services/default-resume", () => ({
  readOrImportDefaultResume: mocks.readOrImportDefaultResume,
}));

vi.mock("@/lib/application-runner/run", () => ({
  runApplicationUntilPause: mocks.runApplicationUntilPause,
}));

import { emptyCandidateProfile } from "@/lib/candidate-profile";
import { startApplication } from "@/lib/application-runner/start";

/** Enough for `missingProfileFields` to report no blocking gap. */
const completeProfile = {
  ...emptyCandidateProfile,
  legalFirstName: "Ada",
  legalLastName: "Lovelace",
  requiresSponsorshipNow: "no",
  workAuthorization: "us_citizen",
  workHistory: [
    {
      company: "Analytical Engines",
      current: false,
      description: "",
      location: "",
      startYear: 2015,
      title: "Mathematician",
    },
  ],
};

const scope = { userId: "ada", workspaceId: "workspace:ada" };
const applyUrl = "https://boards.example/acme/jobs/1";

const input = {
  applyUrl,
  company: "Acme",
  role: "Strategic Finance",
  rootSessionId: "wrun_1",
  scope,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createApplicationExecution.mockResolvedValue(undefined);
  mocks.updateApplicationRun.mockResolvedValue(undefined);
  mocks.findApplicationRun.mockResolvedValue(undefined);
  mocks.readCandidateProfile.mockResolvedValue(completeProfile);
  mocks.readOrImportDefaultResume.mockResolvedValue(undefined);
  mocks.claimApplicationLease.mockResolvedValue({
    expiresAt: "2026-09-02T21:14:06.939Z",
    status: "acquired",
  });
});

describe("startApplication", () => {
  it("finishes the fill before returning when no durable run owns it", async () => {
    let settled = false;
    mocks.runApplicationUntilPause.mockImplementation(async () => {
      await Promise.resolve();
      settled = true;
      return {
        applyUrl,
        message: "Needs submission approval: Strategic Finance",
        pause: "approval",
      };
    });

    const result = await startApplication(input);

    // The regression: the fill used to be launched with a bare `void` and was
    // abandoned the moment the caller's invocation ended.
    expect(mocks.runApplicationUntilPause).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(result).toMatchObject({
      applyUrl,
      pause: "approval",
      status: "waiting",
    });
  });

  it("reports a completed submission from the inline run", async () => {
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      done: true,
      message: "Submitted Strategic Finance.",
    });

    await expect(startApplication(input)).resolves.toMatchObject({
      done: true,
      status: "completed",
    });
  });

  it("marks the run inline so continue_application drives the next step", async () => {
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs email OTP: check your inbox",
      pause: "email_otp",
    });

    await startApplication(input);

    const marked = mocks.updateApplicationRun.mock.calls.at(0)?.[0];
    expect(marked?.status).toBe("running");
    expect(marked?.workflowRunId?.startsWith("inline:")).toBe(true);
  });

  it("retries a posting whose previous run timed out", async () => {
    // The watchdog leaves the workflow id on the row it timed out, and the same
    // session reuses that row, so this used to refuse the posting forever.
    mocks.findApplicationRun.mockResolvedValue({
      browserSessionId: "dead-session",
      id: "prev",
      status: "timed_out",
      workflowRunId: "inline:prev",
    });
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs submission approval: Strategic Finance",
      pause: "approval",
    });

    const result = await startApplication(input);

    expect(mocks.runApplicationUntilPause).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pause: "approval", status: "waiting" });
  });

  it("drops the closed browser session before refilling", async () => {
    mocks.findApplicationRun.mockResolvedValue({
      browserSessionId: "dead-session",
      id: "prev",
      status: "timed_out",
      workflowRunId: "inline:prev",
    });
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs submission approval: Strategic Finance",
      pause: "approval",
    });

    await startApplication(input);

    expect(mocks.updateApplicationRun.mock.calls.at(0)?.[0]).toMatchObject({
      browserSessionId: "",
      pauseReason: null,
    });
  });

  it("still refuses a posting whose run is waiting on the candidate", async () => {
    mocks.findApplicationRun.mockResolvedValue({
      id: "prev",
      status: "waiting",
      workflowRunId: "inline:prev",
    });

    const result = await startApplication(input);

    expect(mocks.runApplicationUntilPause).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "already_in_progress" });
  });

  it("does not start a second run while one already holds the posting", async () => {
    mocks.claimApplicationLease.mockResolvedValue({
      existingExecutionId: "held",
      status: "already_in_progress",
    });

    const result = await startApplication(input);

    expect(mocks.runApplicationUntilPause).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "already_in_progress" });
  });
});

describe("the profile gate", () => {
  it("refuses an empty profile before it costs anything", async () => {
    mocks.readCandidateProfile.mockResolvedValue({ ...emptyCandidateProfile });

    const result = await startApplication(input);

    expect(result).toMatchObject({ status: "needs_profile" });
    // The whole point: no lease claimed, no execution row, no browser opened.
    expect(mocks.createApplicationExecution).not.toHaveBeenCalled();
    expect(mocks.claimApplicationLease).not.toHaveBeenCalled();
    expect(mocks.runApplicationUntilPause).not.toHaveBeenCalled();
  });

  it("names every gap at once rather than one per message", async () => {
    mocks.readCandidateProfile.mockResolvedValue({ ...emptyCandidateProfile });

    const result = await startApplication(input);

    const missing = "missing" in result ? result.missing : [];
    expect(missing).toEqual([
      "legal first name",
      "legal last name",
      "work authorization",
      "sponsorship needed now",
      "work history",
    ]);
    const message = "message" in result ? result.message : "";
    for (const label of missing) expect(message).toContain(label);
  });

  it("narrows the ask to what a resume cannot carry", async () => {
    mocks.readCandidateProfile.mockResolvedValue({ ...emptyCandidateProfile });
    mocks.readOrImportDefaultResume.mockResolvedValue({ id: "resume-1" });

    const result = await startApplication(input);

    expect("missing" in result ? result.missing : []).toEqual([
      "work authorization",
      "sponsorship needed now",
    ]);
  });

  it("treats an unreachable resume as one on file", async () => {
    // The gate exists to skip a doomed run, not to invent a refusal when
    // JuiceBox is down.
    mocks.readCandidateProfile.mockResolvedValue({ ...emptyCandidateProfile });
    mocks.readOrImportDefaultResume.mockRejectedValue(new Error("gateway"));

    const result = await startApplication(input);

    expect("missing" in result ? result.missing : []).toEqual([
      "work authorization",
      "sponsorship needed now",
    ]);
  });

  it("starts as before when the profile cannot be read", async () => {
    mocks.readCandidateProfile.mockRejectedValue(new Error("database"));
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs submission approval: Strategic Finance",
      pause: "approval",
    });

    const result = await startApplication(input);

    expect(mocks.claimApplicationLease).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "waiting" });
  });

  it("claims the lease when the profile is complete", async () => {
    mocks.runApplicationUntilPause.mockResolvedValue({
      applyUrl,
      message: "Needs submission approval: Strategic Finance",
      pause: "approval",
    });

    await startApplication(input);

    expect(mocks.claimApplicationLease).toHaveBeenCalled();
  });
});
