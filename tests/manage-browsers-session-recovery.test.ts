import { beforeEach, describe, expect, it, vi } from "vitest";
import manageBrowsers from "../agent/subagents/worker/tools/manage_browsers";

const mocks = vi.hoisted(() => ({
  deleteBrowserSession:
    vi.fn<(_scope: unknown, _sessionId: string) => Promise<boolean>>(),
  deleteByID: vi.fn<(_sessionId: string, _options: unknown) => Promise<void>>(),
  listBrowserSessions:
    vi.fn<
      (_scope: unknown) => Promise<{ createdAt: string; sessionId: string }[]>
    >(),
  readBrowserSession:
    vi.fn<
      (
        _scope: unknown,
        _sessionId: string
      ) => Promise<{ createdAt: string; sessionId: string } | undefined>
    >(),
  requireWorkerScope: vi.fn<(_context: unknown) => Promise<unknown>>(),
  retrieveBrowser:
    vi.fn<
      (
        _sessionId: string,
        _input: unknown,
        _options: unknown
      ) => Promise<unknown>
    >(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));

vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: vi.fn<() => Promise<void>>(),
  deleteBrowserSession: mocks.deleteBrowserSession,
  listBrowserSessions: mocks.listBrowserSessions,
  readBrowserSession: mocks.readBrowserSession,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      deleteByID: mocks.deleteByID,
      retrieve: mocks.retrieveBrowser,
    },
  },
}));

describe("manage_browsers reconciles a reclaimed Kernel session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkerScope.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    mocks.readBrowserSession.mockResolvedValue({
      createdAt: "2026-08-30T00:00:00.000Z",
      sessionId: "browser-1",
    });
    mocks.deleteBrowserSession.mockResolvedValue(true);
  });

  it("still drops the local row when Kernel expired the session first", async () => {
    // Kernel reclaims a session at its timeout. Deleting it then used to throw
    // before the local row was removed, stranding the row permanently.
    mocks.deleteByID.mockRejectedValue(
      kernelError(410, "session_gone", "browser session no longer exists")
    );

    await expect(
      manageBrowsers.execute(
        { action: "delete", session_id: "browser-1" },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
        { abortSignal: undefined } as never
      )
    ).resolves.toBe("Browser session deleted successfully");

    expect(mocks.deleteBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
      "browser-1"
    );
  });

  it("keeps a delete failure that is not a reclaimed session", async () => {
    mocks.deleteByID.mockRejectedValue(new Error("kernel is unreachable"));

    await expect(
      manageBrowsers.execute(
        { action: "delete", session_id: "browser-1" },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
        { abortSignal: undefined } as never
      )
    ).rejects.toThrow("kernel is unreachable");

    // The browser may still be alive, so the row must survive.
    expect(mocks.deleteBrowserSession).not.toHaveBeenCalled();
  });

  it("forgets a reclaimed session while listing instead of only hiding it", async () => {
    mocks.listBrowserSessions.mockResolvedValue([
      { createdAt: "2026-08-30T00:00:00.000Z", sessionId: "browser-dead" },
      { createdAt: "2026-08-30T00:01:00.000Z", sessionId: "browser-live" },
    ]);
    mocks.retrieveBrowser.mockImplementation(async (sessionId) => {
      if (sessionId === "browser-dead") {
        throw kernelError(404, "not_found", "browser session not found");
      }
      return {
        browser_live_view_url: `https://live.kernel.test/${sessionId}`,
        deleted_at: null,
        session_id: sessionId,
        viewport: null,
      };
    });

    const page = await manageBrowsers.execute(
      { action: "list" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Eve tool context is external runtime state.
      { abortSignal: undefined } as never
    );

    expect(page).toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ session_id: "browser-live" })],
      })
    );
    expect(mocks.deleteBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
      "browser-dead"
    );
  });
});

function kernelError(status: number, code: string, message: string) {
  return Object.assign(new Error(`${String(status)} ${message}`), {
    error: { code, message },
    status,
  });
}
