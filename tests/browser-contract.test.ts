import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import manageBrowsers from "../agent/subagents/worker/tools/manage_browsers";

const mocks = vi.hoisted(() => ({
  createRemoteBrowser: vi.fn<
    (_input: unknown) => Promise<{
      browser_live_view_url: string;
      created_at: string;
      session_id: string;
      status: "active";
      viewport?: { height: number; width: number };
    }>
  >(),
  createBrowserSession:
    vi.fn<(_scope: unknown, _record: unknown) => Promise<void>>(),
  requireWorkerScope: vi.fn<(_context: unknown) => Promise<unknown>>(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));

vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: mocks.createBrowserSession,
  deleteBrowserSession: vi.fn<() => Promise<boolean>>(),
  listBrowserSessions: vi.fn<() => Promise<never[]>>(),
}));

vi.mock("@/lib/browser", () => ({
  createRemoteBrowser: mocks.createRemoteBrowser,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.createRemoteBrowser.mockResolvedValue({
    browser_live_view_url: "https://inspect.brightdata.test/browser-1",
    created_at: "2026-08-27T00:00:00.000Z",
    session_id: "browser-1",
    status: "active",
  });
});

describe("Bright Data browser contract", () => {
  it("keeps agent-created browsers alive for at least 15 minutes", () => {
    const inputSchema = manageBrowsers.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("manage_browsers must use a Zod input schema.");
    }

    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 120,
      }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 900,
      }).success
    ).toBe(true);
  });

  it("returns the live-view URL for a created browser", async () => {
    const execute = manageBrowsers.execute;

    const result = await execute({ action: "create" }, {} as never);
    expect(result).toMatchObject({
      browser: {
        browser_live_view_url: "https://inspect.brightdata.test/browser-1",
      },
    });

    expect(mocks.createRemoteBrowser).toHaveBeenCalledExactlyOnceWith({
      startUrl: undefined,
      viewport: undefined,
    });
  });

  it("passes a viewport to Bright Data when both dimensions are set", async () => {
    const execute = manageBrowsers.execute;

    await execute(
      { action: "create", viewport_height: 900, viewport_width: 1440 },
      {} as never
    );

    expect(mocks.createRemoteBrowser).toHaveBeenCalledExactlyOnceWith({
      startUrl: undefined,
      viewport: { height: 900, width: 1440 },
    });
  });
});
