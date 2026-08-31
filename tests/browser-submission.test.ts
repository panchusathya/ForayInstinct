import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPageLocation,
  groupBrowserRunCheckpoints,
  observedSubmission,
} from "../lib/browser-submission";

const mocks = vi.hoisted(() => ({
  currentKernelPageUrl: vi.fn<() => Promise<string | undefined>>(),
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
        _input: { code: string },
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
  currentKernelPageUrl: mocks.currentKernelPageUrl,
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
    mocks.currentKernelPageUrl.mockResolvedValue(undefined);
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
        kind: "submitted",
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

const scrollAdvanceCode = "top: before + window.innerHeight";
const scrollResetCode = "top: 0";
const maskAddCode = "style.id = styleId";
const maskRemoveCode = "getElementById(styleId)?.remove()";

describe("the review gate pauses an application before its final submit", () => {
  let executedCode: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    executedCode = [];
    mocks.requireWorkerScope.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    mocks.requireOwnedBrowserSession.mockResolvedValue({
      sessionId: "browser-1",
    });
    mocks.recordBrowserRunCheckpoint.mockResolvedValue();
    mocks.saveApplicationSubmissionScreenshot.mockResolvedValue();
    mocks.currentKernelPageUrl.mockResolvedValue(
      "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review?step=4"
    );
    mocks.snapshotKernelPage.mockResolvedValue({
      body: "Review your application. Submit",
      url: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review",
    });
    mocks.captureScreenshot.mockResolvedValue({
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    });
    // Reports one more viewport below the fold, then the bottom of the form.
    let advances = 0;
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (!code.includes(scrollAdvanceCode)) return { success: true };
      advances += 1;
      return { result: { atBottom: advances >= 2 }, success: true };
    });
  });

  it("stores each review slice and records the pause without submitting", async () => {
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({ captured: 2, status: "awaiting_approval" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledTimes(2);
    for (const call of mocks.saveApplicationSubmissionScreenshot.mock.calls) {
      // The role and apply URL travel with the image: the delivering channel
      // captions by name, so a thread with two applications in flight can tell
      // them apart instead of numbering both into one ambiguous run.
      expect(call[2]).toEqual({
        applyUrl:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        kind: "review",
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review",
        png: Buffer.from([137, 80, 78, 71]),
        role: "Staff Engineer",
      });
    }
    // The trail is how the coordinator matches a paused worker to a posting.
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      {
        action: "review",
        actions: [
          "role: Staff Engineer",
          "apply_url: https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
          "review screenshots: 2",
        ],
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review",
        phase: "submission_approval",
        state: "awaiting_approval",
      }
    );
  });

  it("never reports a pause as an observed submission", async () => {
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    for (const call of mocks.recordBrowserRunCheckpoint.mock.calls) {
      expect(call[2]).not.toMatchObject({ state: "submission_observed" });
    }
    for (const call of mocks.saveApplicationSubmissionScreenshot.mock.calls) {
      expect(call[2]).not.toMatchObject({ kind: "submitted" });
    }
    // Nothing the gate runs may activate a control on the page.
    for (const code of executedCode) {
      expect(code).not.toMatch(/\.click\(|press\(|Submit/);
    }
  });

  it("holds the vault mask across every slice and leaves the page at the top", async () => {
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    // Masking per capture would unmask the page between shots and could expose
    // an injected password in the next one.
    expect(
      executedCode.filter((code) => code.includes(maskAddCode))
    ).toHaveLength(1);
    const removeIndex = executedCode.findIndex((code) =>
      code.includes(maskRemoveCode)
    );
    expect(removeIndex).toBe(executedCode.length - 1);
    expect(
      executedCode.filter((code) => code.includes(scrollResetCode))
    ).toHaveLength(1);
  });

  it("stops capturing at the slice ceiling when the page never reports a bottom", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (!code.includes(scrollAdvanceCode)) return { success: true };
      return { result: { atBottom: false }, success: true };
    });
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({ captured: 3 });
  });

  it("still gates when no screenshot could be captured", async () => {
    mocks.captureScreenshot.mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({
      captured: 0,
      capture_status: "unavailable",
      status: "awaiting_approval",
    });
    // With no screenshot, the candidate needs the live view to check the form.
    expect(JSON.stringify(result)).toContain("live-view URL");
    expect(mocks.saveApplicationSubmissionScreenshot).not.toHaveBeenCalled();
  });

  it("still pauses and records zero review screenshots when capture throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.captureScreenshot.mockRejectedValueOnce(
      new Error("capture unavailable")
    );
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({
      captured: 0,
      capture_status: "unavailable",
      status: "awaiting_approval",
    });
    expect(JSON.stringify(result)).toContain("could not be sent");
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      {
        action: "review",
        actions: [
          "role: Staff Engineer",
          "apply_url: https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
          "review screenshots: 0",
        ],
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review",
        phase: "submission_approval",
        state: "awaiting_approval",
      }
    );
    expect(mocks.saveApplicationSubmissionScreenshot).not.toHaveBeenCalled();
  });

  it("captures the review when the secondary screenshot mask is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (code.includes(maskAddCode)) {
        return { error: "mask execution rejected", success: false };
      }
      if (!code.includes(scrollAdvanceCode)) return { success: true };
      return { result: { atBottom: true }, success: true };
    });
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({ captured: 1, capture_status: "captured" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "[vault-screenshot-mask] could not apply",
      expect.objectContaining({ error: "mask execution rejected" })
    );
  });

  it("captures the review when the secondary screenshot mask throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (code.includes(maskAddCode)) {
        throw new Error("mask transport unavailable");
      }
      if (!code.includes(scrollAdvanceCode)) return { success: true };
      return { result: { atBottom: true }, success: true };
    });
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({ captured: 1, capture_status: "captured" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "[vault-screenshot-mask] could not apply",
      expect.objectContaining({ error: "mask transport unavailable" })
    );
  });
});
