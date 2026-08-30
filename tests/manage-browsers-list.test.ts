import { beforeEach, describe, expect, it, vi } from "vitest";
import manageBrowsers from "../agent/subagents/worker/tools/manage_browsers";

const mocks = vi.hoisted(() => ({
  listBrowserSessions:
    vi.fn<
      (
        _scope: unknown
      ) => Promise<Array<{ createdAt: string; sessionId: string }>>
    >(),
  retrieveBrowser: vi.fn<
    (
      _sessionId: string,
      _input: unknown,
      _options: unknown
    ) => Promise<{
      browser_live_view_url: string;
      deleted_at: string | null;
      session_id: string;
      viewport: null;
    }>
  >(),
  requireWorkerScope: vi.fn<(_context: unknown) => Promise<unknown>>(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));

vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: vi.fn<() => Promise<void>>(),
  deleteBrowserSession: vi.fn<() => Promise<boolean>>(),
  listBrowserSessions: mocks.listBrowserSessions,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      retrieve: mocks.retrieveBrowser,
    },
  },
}));

describe("manage_browsers list pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkerScope.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    mocks.listBrowserSessions.mockResolvedValue([
      { createdAt: "2026-08-30T00:00:00.000Z", sessionId: "browser-1" },
      { createdAt: "2026-08-30T00:01:00.000Z", sessionId: "browser-2" },
      { createdAt: "2026-08-30T00:02:00.000Z", sessionId: "browser-3" },
    ]);
    mocks.retrieveBrowser.mockImplementation(async (sessionId) => ({
      browser_live_view_url: `https://live.kernel.test/${sessionId}`,
      deleted_at: null,
      session_id: sessionId,
      viewport: null,
    }));
  });

  it("reports remaining pages instead of claiming the list is complete", async () => {
    const page = await manageBrowsers.execute(
      { action: "list", limit: 2, offset: 0 },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(page).toEqual({
      has_more: true,
      items: [
        expect.objectContaining({ session_id: "browser-1" }),
        expect.objectContaining({ session_id: "browser-2" }),
      ],
      next_offset: 2,
    });

    const rest = await manageBrowsers.execute(
      { action: "list", limit: 2, offset: 2 },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      {} as never
    );

    expect(rest).toEqual({
      has_more: false,
      items: [expect.objectContaining({ session_id: "browser-3" })],
      next_offset: null,
    });
  });
});
