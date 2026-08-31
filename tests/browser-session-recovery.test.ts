import { describe, expect, it } from "vitest";
import {
  browserSessionEndedError,
  browserSessionNotOwnedMessage,
  describeBrowserSessionFailure,
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
