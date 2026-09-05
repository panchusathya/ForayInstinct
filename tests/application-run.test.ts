import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureApproval: vi.fn<() => Promise<Record<string, unknown>>>(),
  closeBrowser: vi.fn<(_input: Record<string, unknown>) => Promise<void>>(),
  fill: vi.fn<
    (_input: Record<string, unknown>) => Promise<Record<string, unknown>>
  >(),
  findRun: vi.fn<() => Promise<unknown>>(),
  openBrowser:
    vi.fn<
      (_input: Record<string, unknown>) => Promise<{ session_id: string }>
    >(),
  updateRun: vi.fn<(_input: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("@/db/services/application-executions", () => ({
  findApplicationRun: mocks.findRun,
  updateApplicationRun: mocks.updateRun,
}));

vi.mock("@/lib/application-runner/browser", () => ({
  closeApplicationBrowser: mocks.closeBrowser,
  openApplicationBrowser: mocks.openBrowser,
}));

vi.mock("@/lib/application-runner/fill", () => ({
  captureApproval: mocks.captureApproval,
  enterVerificationCode: vi.fn<() => Promise<undefined>>(),
  fillVisibleForm: mocks.fill,
  submitApplication: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

import { runApplicationUntilPause } from "@/lib/application-runner/run";

const input = {
  applyUrl: "https://hirro.example/job/associate-finance",
  company: "Hirro",
  executionId: "exec-1",
  role: "Associate",
  rootSessionId: "root-1",
  scope: { userId: "alice", workspaceId: "workspace:alice" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ browserSessionId: "browser-1" });
  mocks.updateRun.mockResolvedValue(undefined);
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.openBrowser.mockResolvedValue({ session_id: "browser-2" });
  mocks.captureApproval.mockResolvedValue({
    applyUrl: input.applyUrl,
    message: "Needs submission approval: Associate",
    pause: "approval",
  });
});

describe("a posting whose form is on another site", () => {
  it("reopens the browser where the form is and fills there", async () => {
    // The browser is pinned to one site and dies on a cross-site hop, so the
    // hop is a new browser, not a click.
    mocks.fill
      .mockResolvedValueOnce({
        applyUrl: input.applyUrl,
        redirect: "https://boards.greenhouse.io/hirro/jobs/123",
      })
      .mockResolvedValueOnce({ continue: true });
    const result = await runApplicationUntilPause(input);
    expect(mocks.closeBrowser).toHaveBeenCalledWith({
      scope: input.scope,
      sessionId: "browser-1",
    });
    expect(mocks.openBrowser).toHaveBeenCalledWith({
      applyUrl: "https://boards.greenhouse.io/hirro/jobs/123",
      executionId: "exec-1",
      scope: input.scope,
    });
    expect(mocks.updateRun).toHaveBeenCalledWith({
      browserSessionId: "browser-2",
      executionId: "exec-1",
    });
    expect(mocks.fill.mock.calls[1]?.[0]).toMatchObject({
      applyUrl: "https://boards.greenhouse.io/hirro/jobs/123",
      browserSessionId: "browser-2",
    });
    expect(result).toMatchObject({ pause: "approval" });
  });

  it("stops at a chain of redirects and says where it led", async () => {
    mocks.fill
      .mockResolvedValueOnce({
        applyUrl: input.applyUrl,
        redirect: "https://one.example/apply",
      })
      .mockResolvedValueOnce({
        applyUrl: "https://one.example/apply",
        redirect: "https://two.example/apply",
      });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "sends them on again to https://two.example/apply"
    );
    expect(mocks.openBrowser).toHaveBeenCalledTimes(1);
  });
});
