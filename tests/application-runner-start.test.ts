import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimApplicationLease: vi.fn<() => Promise<Record<string, unknown>>>(),
  createApplicationExecution: vi.fn<() => Promise<void>>(),
  findApplicationRun: vi.fn<() => Promise<undefined>>(),
  runApplicationUntilPause: vi.fn<() => Promise<Record<string, unknown>>>(),
  updateApplicationRun:
    vi.fn<
      (_input: { status?: string; workflowRunId?: string }) => Promise<void>
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

vi.mock("@/lib/application-runner/run", () => ({
  runApplicationUntilPause: mocks.runApplicationUntilPause,
}));

import { startApplication } from "@/lib/application-runner/start";

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
