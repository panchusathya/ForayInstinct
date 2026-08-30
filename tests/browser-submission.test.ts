import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPageLocation,
  groupBrowserRunCheckpoints,
  observedSubmission,
} from "../lib/browser-submission";

const mocks = vi.hoisted(() => ({
  captureScreenshot:
    vi.fn<
      (
        _sessionId: string,
        _input: unknown,
        _options: unknown
      ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>
    >(),
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _input: unknown,
        _options: unknown
      ) => Promise<{ error?: string; result?: unknown; success: boolean }>
    >(),
  recordBrowserRunCheckpoint:
    vi.fn<
      (
        _scope: unknown,
        _sessionId: string,
        _checkpoint: unknown
      ) => Promise<void>
    >(),
  requireOwnedBrowserSession:
    vi.fn<(_scope: unknown, _sessionId: string) => Promise<unknown>>(),
  requireWorkerScope: vi.fn<(_context: unknown) => Promise<unknown>>(),
  saveApplicationSubmissionScreenshot:
    vi.fn<
      (
        _scope: unknown,
        _sessionId: string,
        _screenshot: unknown
      ) => Promise<void>
    >(),
  snapshotKernelPage:
    vi.fn<(_input: unknown) => Promise<{ body: string; url: string }>>(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));

vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));

vi.mock("@/db/services/browser-run-checkpoints", () => ({
  recordBrowserRunCheckpoint: mocks.recordBrowserRunCheckpoint,
}));

vi.mock("@/db/services/application-submission-screenshots", () => ({
  saveApplicationSubmissionScreenshot:
    mocks.saveApplicationSubmissionScreenshot,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      computer: { captureScreenshot: mocks.captureScreenshot },
      playwright: { execute: mocks.executePlaywright },
    },
  },
}));

vi.mock("@/lib/manager/server/kernel-native-autofill", () => ({
  currentKernelPageUrl: vi.fn<() => Promise<undefined>>(async () => undefined),
  snapshotKernelPage: mocks.snapshotKernelPage,
}));

describe("browser submission evidence", () => {
  it("classifies confirmation URLs and conservative body phrases", () => {
    expect(
      observedSubmission(
        "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted",
        ""
      )
    ).toBe("application submitted");
    expect(
      observedSubmission(
        "https://tenant.myworkdayjobs.com/en-US/job/role/confirmation",
        ""
      )
    ).toBe("application submitted");
    expect(
      observedSubmission("https://tenant.example/apply", "Thank you")
    ).toBeUndefined();
    expect(
      observedSubmission("https://tenant.example/apply", "Thank you")
    ).toBeUndefined();
    expect(
      observedSubmission(
        "https://tenant.example/apply",
        "We have received your materials."
      )
    ).toBeUndefined();
    expect(
      observedSubmission(
        "https://tenant.example/apply",
        "Your application has been submitted."
      )
    ).toBe("application received");
    expect(
      observedSubmission(
        "https://tenant.example/apply",
        "You have successfully submitted your application."
      )
    ).toBe("successfully submitted");
    expect(
      observedSubmission(
        "https://tenant.example/job/role",
        "Continue application"
      )
    ).toBeUndefined();
  });

  it("stores origin and pathname without query strings", () => {
    expect(
      browserPageLocation(
        "https://tenant.myworkdayjobs.com/en-US/job/role?foo=1#bar"
      )
    ).toBe("https://tenant.myworkdayjobs.com/en-US/job/role");
  });

  it("groups checkpoints by browser session in recency order", () => {
    const sessions = groupBrowserRunCheckpoints([
      {
        action: "execute",
        actions: ["thank you"],
        attempt: 0,
        createdAt: "2026-08-29T20:00:00.000Z",
        errorCode: null,
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role",
        phase: "playwright",
        sessionId: "intapp-browser",
        state: "submission_observed",
        trace: [],
      },
      {
        action: "create",
        actions: [],
        attempt: 0,
        createdAt: "2026-08-29T19:00:00.000Z",
        errorCode: null,
        page: "https://workday.wd5.myworkdayjobs.com/en-US/job/costa-rica",
        phase: "browser",
        sessionId: "costa-browser",
        state: "created",
        trace: [],
      },
      {
        action: "create",
        actions: [],
        attempt: 0,
        createdAt: "2026-08-29T18:00:00.000Z",
        errorCode: null,
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role",
        phase: "browser",
        sessionId: "intapp-browser",
        state: "created",
        trace: [],
      },
    ]);

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "intapp-browser",
      "costa-browser",
    ]);
    expect(sessions[0]?.pages).toEqual([
      "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role",
    ]);
    expect(sessions[0]?.checkpoints).toHaveLength(2);
  });
});

describe("playwright checkpoints observe a submission without final_output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkerScope.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    mocks.requireOwnedBrowserSession.mockResolvedValue({
      sessionId: "browser-1",
    });
    mocks.recordBrowserRunCheckpoint.mockResolvedValue();
    mocks.saveApplicationSubmissionScreenshot.mockResolvedValue();
    mocks.executePlaywright.mockResolvedValue({
      result: { success: true },
      success: true,
    });
    mocks.captureScreenshot.mockResolvedValue({
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    });
    mocks.snapshotKernelPage.mockResolvedValue({
      body: "Thank you. We have received your application.",
      url: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted?ref=1",
    });
  });

  it("adds submission evidence without replacing the Playwright result", async () => {
    const { default: executePlaywrightCode } =
      await import("../agent/subagents/worker/tools/execute_playwright_code");

    await executePlaywrightCode.execute(
      { code: "await page.click('text=Submit')", session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        actions: ["submission evidence: application submitted"],
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted",
        phase: "playwright",
        state: "completed",
      })
    );
    expect(mocks.captureScreenshot).toHaveBeenCalledWith(
      "browser-1",
      {},
      expect.objectContaining({})
    );
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      {
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted",
        png: Buffer.from([137, 80, 78, 71]),
      }
    );
  });

  it("does not capture a confirmation screenshot when the ATS page is not a submission", async () => {
    mocks.snapshotKernelPage.mockResolvedValue({
      body: "Continue application",
      url: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role",
    });
    const { default: executePlaywrightCode } =
      await import("../agent/subagents/worker/tools/execute_playwright_code");

    await executePlaywrightCode.execute(
      { code: "await page.click('text=Continue')", session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        phase: "playwright",
        state: "completed",
      })
    );
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
    expect(mocks.saveApplicationSubmissionScreenshot).not.toHaveBeenCalled();
  });

  it("does not promote a failed Playwright step to submission_observed", async () => {
    mocks.executePlaywright.mockResolvedValue({
      result: { success: false },
      success: false,
    });
    mocks.snapshotKernelPage.mockResolvedValue({
      body: "Thank you for applying. We have received your application.",
      url: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
    });
    const { default: executePlaywrightCode } =
      await import("../agent/subagents/worker/tools/execute_playwright_code");

    await executePlaywrightCode.execute(
      { code: "await page.click('text=Submit')", session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        actions: ["submission evidence: application received"],
        errorCode: "playwright_execution",
        phase: "playwright",
        state: "failed",
      })
    );
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
    expect(mocks.saveApplicationSubmissionScreenshot).not.toHaveBeenCalled();
  });
});
