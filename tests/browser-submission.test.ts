import { Script } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPageLocation,
  groupBrowserRunCheckpoints,
  maxApplicationReviewCaptures,
  observedSubmission,
} from "../lib/browser-submission";
import {
  reviewScrollCode,
  reviewScrollRootProbeCode,
} from "../agent/subagents/worker/lib/kernel-screenshot";
import { captchaProbeCode } from "../agent/subagents/worker/lib/captcha-solver";
import {
  playwrightObserveThenActInstruction,
  playwrightUploadPayloadInstruction,
} from "../agent/subagents/worker/lib/challenge-diagnostics";

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
        actions: expect.arrayContaining([
          "submission evidence: application received",
        ]),
        errorCode: "playwright_execution",
        phase: "playwright",
        state: "failed",
      })
    );
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
    expect(mocks.saveApplicationSubmissionScreenshot).not.toHaveBeenCalled();
  });

  it("asks the worker to re-observe after a Playwright timeout instead of probing for a CAPTCHA", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.executePlaywright.mockResolvedValue({
      error: "The operation was aborted due to timeout",
      success: false,
    });
    const { default: executePlaywrightCode } =
      await import("../agent/subagents/worker/tools/execute_playwright_code");

    const result = await executePlaywrightCode.execute(
      {
        code: "await page.locator('#resume').setInputFiles('/tmp/goforay-resume.pdf')",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({
      next_action: playwrightObserveThenActInstruction,
      success: false,
    });
    expect(mocks.executePlaywright).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      expect.objectContaining({ timeout_sec: 30 }),
      expect.objectContaining({})
    );
    expect(
      mocks.executePlaywright.mock.calls.some((call) => {
        const input = call[1];
        return (
          typeof input === "object" &&
          input !== null &&
          "code" in input &&
          input.code === captchaProbeCode
        );
      })
    ).toBe(false);
  });

  it("forbids retrying a broken setInputFiles Buffer payload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.executePlaywright.mockResolvedValue({
      error:
        "locator.setInputFiles: payloads[0].buffer: expected Buffer, got undefined",
      success: false,
    });
    const { default: executePlaywrightCode } =
      await import("../agent/subagents/worker/tools/execute_playwright_code");

    const result = await executePlaywrightCode.execute(
      {
        code: "await page.locator('#resume').setInputFiles({ buffer: undefined })",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({
      next_action: playwrightUploadPayloadInstruction,
      success: false,
    });
    expect(
      mocks.executePlaywright.mock.calls.some((call) => {
        const input = call[1];
        return (
          typeof input === "object" &&
          input !== null &&
          "code" in input &&
          input.code === captchaProbeCode
        );
      })
    ).toBe(false);
  });
});

const maskAddCode = "style.id = styleId";
const maskRemoveCode = "getElementById(styleId)?.remove()";
/** Matched against the shipped code, so the test cannot drift away from it. */
const reviewProbeCode = "const probe = (attribute)";
const reviewScrollTargetPattern = /const targetTop = (\d+);/u;
const isReviewScroll = (code: string) =>
  reviewScrollTargetPattern.test(code) && !code.includes(reviewProbeCode);

/**
 * A real capture differs between slices; a mock that returns one buffer forever
 * would be indistinguishable from a page that never scrolled.
 */
function distinctScreenshots() {
  let frame = 0;
  return async () => ({
    arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71, frame++]).buffer,
  });
}

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
    mocks.captureScreenshot.mockImplementation(distinctScreenshots());
    mocks.executePlaywright.mockImplementation(
      reviewBrowser({ clientHeight: 900, maxScroll: 1800, scrollTop: 1800 })
    );
  });

  /**
   * A form that scrolls an inner container, which is what a Workday wizard and
   * an embedded Greenhouse form both do: the probe reports the container and
   * every scroll lands on it.
   */
  function reviewBrowser(root: {
    clientHeight: number;
    maxScroll: number;
    scrollTop: number;
  }) {
    return async (_sessionId: string, { code }: { code: string }) => {
      executedCode.push(code);
      if (code.includes(reviewProbeCode))
        return { result: root, success: true };
      const target = reviewScrollTargetPattern.exec(code);
      if (target) {
        return {
          result: { scrollTop: Math.min(Number(target[1]), root.maxScroll) },
          success: true,
        };
      }
      return { success: true };
    };
  }

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

    // A 1800px scroll over a 900px container is four overlapping slices: the
    // top, two middles, and the submit control at the end.
    expect(result).toMatchObject({ captured: 4, status: "awaiting_approval" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledTimes(4);
    for (const call of mocks.saveApplicationSubmissionScreenshot.mock.calls) {
      // The role and apply URL travel with the image: the delivering channel
      // captions by name, so a thread with two applications in flight can tell
      // them apart instead of numbering both into one ambiguous run.
      expect(call[2]).toMatchObject({
        applyUrl:
          "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
        kind: "review",
        page: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/review",
        role: "Staff Engineer",
      });
    }
    // Each slice is its own image, never the same shot stored four times.
    const stored = mocks.saveApplicationSubmissionScreenshot.mock.calls.flatMap(
      (call) => {
        const screenshot: unknown = call[2];
        if (typeof screenshot !== "object" || screenshot === null) return [];
        const { png } = screenshot as { png?: unknown };
        return Buffer.isBuffer(png) ? [png.toString("base64")] : [];
      }
    );
    expect(new Set(stored).size).toBe(4);
    // The trail is how the coordinator matches a paused worker to a posting.
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      {
        action: "review",
        actions: [
          "role: Staff Engineer",
          "apply_url: https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply",
          "review screenshots: 4",
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

  it("holds the vault mask across every slice and puts the page back where it was", async () => {
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
    const scrolls = executedCode.filter(isReviewScroll);
    // Four slices, then the page put back where the worker left it: it resumes
    // on this page to press submit.
    expect(scrolls).toHaveLength(5);
    expect(reviewScrollTargetPattern.exec(scrolls.at(-1) ?? "")?.[1]).toBe(
      "1800"
    );
    // Every scroll drives the container the probe tagged, never the window.
    for (const scroll of scrolls) {
      expect(scroll).toContain("data-foray-review-root");
      expect(scroll).not.toContain("window.scrollTo");
    }
  });

  it("slices a form that scrolls an inner container rather than the document", async () => {
    // The production failure: measuring the document reports nothing to scroll,
    // so the review collapsed to one shot of wherever the worker stopped.
    mocks.executePlaywright.mockImplementation(
      reviewBrowser({ clientHeight: 700, maxScroll: 2100, scrollTop: 2100 })
    );
    const { default: requestSubmissionApproval } =
      await import("../agent/subagents/worker/tools/request_submission_approval");

    const result = await requestSubmissionApproval.execute(
      {
        apply_url: "https://boards.greenhouse.io/acme/jobs/1/apply",
        role: "Staff Engineer",
        session_id: "browser-1",
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(result).toMatchObject({ captured: 5 });
    const offsets = executedCode
      .filter(isReviewScroll)
      .map((code) => reviewScrollTargetPattern.exec(code)?.[1]);
    // The top and the end of the form are always in the set.
    expect(offsets.slice(0, 5)).toEqual(["0", "525", "1050", "1575", "2100"]);
  });

  it("spreads the slices evenly over a form taller than the capture cap", async () => {
    mocks.executePlaywright.mockImplementation(
      reviewBrowser({ clientHeight: 900, maxScroll: 4200, scrollTop: 0 })
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

    expect(result).toMatchObject({ captured: maxApplicationReviewCaptures });
    const offsets = executedCode
      .filter(isReviewScroll)
      .map((code) => reviewScrollTargetPattern.exec(code)?.[1]);
    expect(offsets.slice(0, maxApplicationReviewCaptures)).toEqual([
      "0",
      "840",
      "1680",
      "2520",
      "3360",
      "4200",
    ]);
  });

  it("photographs the page where it stands when nothing is measurable", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (code.includes(reviewProbeCode))
        return { result: null, success: true };
      return { success: true };
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

    // Moving a page that could not be measured risks losing the worker's place
    // for nothing, so it is photographed as it is.
    expect(result).toMatchObject({ captured: 1, capture_status: "captured" });
    expect(executedCode.filter(isReviewScroll)).toHaveLength(0);
  });

  it("stops slicing a page that will not scroll any further", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, { code }) => {
      executedCode.push(code);
      if (code.includes(reviewProbeCode)) {
        return {
          result: { clientHeight: 900, maxScroll: 4200, scrollTop: 0 },
          success: true,
        };
      }
      if (reviewScrollTargetPattern.test(code)) {
        // A container that reports the same position however far it is asked to
        // move has nothing new to show.
        return { result: { scrollTop: 0 }, success: true };
      }
      return { success: true };
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

    expect(result).toMatchObject({ captured: 1 });
  });

  it("ships review code the browser can actually run", () => {
    // The probe hands a function to `frame.evaluate`, so a syntax error here
    // would otherwise surface only against a live application.
    expect(
      () => new Script(`(async () => {${reviewScrollRootProbeCode}})()`)
    ).not.toThrow();
    expect(
      () => new Script(`(async () => {${reviewScrollCode(1200, true)}})()`)
    ).not.toThrow();
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
    // The gate still holds, and the fallback is reading the answers back rather
    // than handing the candidate a browser link they have no use for.
    expect(JSON.stringify(result)).toContain("could not be captured");
    expect(JSON.stringify(result)).toContain(
      "Do not include the browser live-view URL"
    );
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
    expect(JSON.stringify(result)).toContain("could not be captured");
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
      if (code.includes(reviewProbeCode)) {
        return {
          result: { clientHeight: 900, maxScroll: 1800, scrollTop: 0 },
          success: true,
        };
      }
      const target = reviewScrollTargetPattern.exec(code);
      if (target)
        return { result: { scrollTop: Number(target[1]) }, success: true };
      return { success: true };
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

    expect(result).toMatchObject({ captured: 4, capture_status: "captured" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledTimes(4);
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
      if (code.includes(reviewProbeCode)) {
        return {
          result: { clientHeight: 900, maxScroll: 1800, scrollTop: 0 },
          success: true,
        };
      }
      const target = reviewScrollTargetPattern.exec(code);
      if (target)
        return { result: { scrollTop: Number(target[1]) }, success: true };
      return { success: true };
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

    expect(result).toMatchObject({ captured: 4, capture_status: "captured" });
    expect(mocks.saveApplicationSubmissionScreenshot).toHaveBeenCalledTimes(4);
    expect(console.warn).toHaveBeenCalledWith(
      "[vault-screenshot-mask] could not apply",
      expect.objectContaining({ error: "mask transport unavailable" })
    );
  });
});
