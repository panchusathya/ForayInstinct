import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPageLocation,
  groupBrowserRunCheckpoints,
  observedSubmission,
} from "../lib/browser-submission";

const mocks = vi.hoisted(() => ({
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

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      playwright: { execute: mocks.executePlaywright },
    },
  },
}));

vi.mock("@/lib/manager/server/kernel-native-autofill", () => ({
  currentKernelPageUrl: vi.fn(async () => undefined),
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
    ).toBe("thank you");
    expect(
      observedSubmission(
        "https://tenant.example/apply",
        "We have received your materials."
      )
    ).toBe("we have received");
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
    mocks.executePlaywright.mockResolvedValue({
      result: { success: true },
      success: true,
    });
    mocks.snapshotKernelPage.mockResolvedValue({
      body: "Thank you. We have received your application.",
      url: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted?ref=1",
    });
  });

  it("records submission_observed from the live page, not the Playwright return", async () => {
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
        actions: ["application submitted"],
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted",
        phase: "playwright",
        state: "submission_observed",
      })
    );
  });
});
