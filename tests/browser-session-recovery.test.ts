import { describe, expect, it } from "vitest";
import {
  browserSessionEndedError,
  browserSessionNotOwnedMessage,
  describeBrowserSessionFailure,
  diagnosticErrorCode,
  isDeadBrowserExecutionError,
  isKernelSessionDead,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";

describe("browser session failure classification", () => {
  it("separates a Kernel-side death from a missing local row", () => {
    // Kernel rejected the session: the local row passed the ownership check.
    expect(
      describeBrowserSessionFailure(
        kernelError(410, "session_gone", "browser session no longer exists")
      )
    ).toBe("session_gone");
    expect(
      describeBrowserSessionFailure(
        kernelError(404, "not_found", "browser session 'abc' not found")
      )
    ).toBe("session_not_found");

    // The local row is absent, so Kernel was never called.
    expect(
      describeBrowserSessionFailure(new Error(browserSessionNotOwnedMessage))
    ).toBe("session_not_owned");
  });

  it("leaves an ordinary page failure unclassified so it can be probed", () => {
    expect(
      describeBrowserSessionFailure(
        new Error("locator.click: Timeout 5000ms exceeded.")
      )
    ).toBeUndefined();
    expect(describeBrowserSessionFailure(undefined)).toBeUndefined();
    expect(describeBrowserSessionFailure("Playwright failed")).toBeUndefined();
  });

  it("recognises a dead browser reported as a soft execution failure", () => {
    // Kernel answers a reclaimed session with a 410, which the classifier above
    // handles. A browser that dies *during* execution comes back as an HTTP 200
    // carrying `success: false` and a message string, so it read as an ordinary
    // code failure and the worker retried against a browser that was gone.
    expect(
      isDeadBrowserExecutionError(
        "Target page, context or browser has been closed"
      )
    ).toBe(true);
    expect(isDeadBrowserExecutionError("Browser has been closed")).toBe(true);
    expect(
      isDeadBrowserExecutionError("browser session no longer exists")
    ).toBe(true);

    // Kept narrow on purpose: an ordinary failure must stay retryable, or the
    // worker throws away a live browser over a missed selector.
    expect(
      isDeadBrowserExecutionError("locator.click: Timeout 5000ms exceeded.")
    ).toBe(false);
    expect(
      isDeadBrowserExecutionError("strict mode violation: 2 elements match")
    ).toBe(false);
    expect(isDeadBrowserExecutionError(undefined)).toBe(false);
  });

  it("classifies a failure the same way whichever tool saw it", () => {
    // Three tools each had their own copy and they had already drifted, so the
    // same error landed on the checkpoint trail under different codes.
    expect(diagnosticErrorCode(new Error("Timeout 5000ms exceeded"))).toBe(
      "timeout"
    );
    expect(diagnosticErrorCode("locator.click failed")).toBe("selector");
    expect(diagnosticErrorCode(new Error("net::ERR_ABORTED"))).toBe(
      "navigation"
    );
    expect(diagnosticErrorCode(new Error("407 proxy auth required"))).toBe(
      "proxy_auth"
    );
    expect(diagnosticErrorCode({ unexpected: true })).toBe(
      "playwright_execution"
    );
    // A successful Playwright route carries no `error`, and stamping that as a
    // failure would mark every resolved Workday route as broken on the trail.
    expect(diagnosticErrorCode(undefined)).toBeUndefined();
    expect(diagnosticErrorCode("")).toBeUndefined();
  });

  it("treats only a Kernel-side death as reclaimed", () => {
    expect(isKernelSessionDead("session_gone")).toBe(true);
    expect(isKernelSessionDead("session_not_found")).toBe(true);
    // The row is gone locally, so there is nothing left to reconcile.
    expect(isKernelSessionDead("session_not_owned")).toBe(false);
    expect(isKernelSessionDead(undefined)).toBe(false);
  });

  it("tells the worker to create a new browser instead of retrying", () => {
    const error = browserSessionEndedError("abc123");
    // The raw Kernel text ("410 browser session no longer exists") reads as a
    // transient fault, which is what produced turns of repeated dead calls.
    expect(error.message).toContain("abc123");
    expect(error.message).toContain("has ended and cannot be reused");
    expect(error.message).toContain(
      "Create a new browser with manage_browsers"
    );
    expect(error.message).toContain("do not reuse this session_id");
  });
});

function kernelError(status: number, code: string, message: string) {
  return Object.assign(new Error(`${String(status)} ${message}`), {
    error: { code, message },
    status,
  });
}
