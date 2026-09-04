import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearState: vi.fn<() => Promise<void>>(),
  createSession: vi.fn<
    (_options: Record<string, unknown>) => Promise<{
      created_at?: string;
      session_id: string;
      status: "active";
    }>
  >(),
  deleteSession: vi.fn<() => Promise<Record<string, unknown>>>(),
  readState: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/lib/browser", () => ({
  browserProvider: {
    createSession: mocks.createSession,
    deleteSession: mocks.deleteSession,
    executePlaywright: vi.fn<() => Promise<unknown>>(),
    name: "gateway",
  },
  isGatewayProvider: () => true,
}));

vi.mock("@/lib/manager/server/browser-state", () => ({
  clearWorkspaceBrowserState: mocks.clearState,
  readWorkspaceBrowserState: mocks.readState,
  saveWorkspaceBrowserState: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/manager/server/kernel-profile", () => ({
  ensureKernelBrowserProfile: vi.fn<() => Promise<string>>(),
}));

vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("@/db/services/application-executions", () => ({
  attachBrowserToApplicationExecution: vi.fn<() => Promise<void>>(
    async () => undefined
  ),
}));

vi.mock("@/db/services/browser-run-checkpoints", () => ({
  recordBrowserRunCheckpoint: vi.fn<() => Promise<void>>(async () => undefined),
}));

import { openApplicationBrowser } from "@/lib/application-runner/browser";

const state = {
  cookies: [{ domain: ".greenhouse.io", name: "cc_ut", path: "/", value: "x" }],
  origins: [],
};
const cookieError = new Error(
  "GatewayRequestError: browserContext.addCookies: Protocol error (Storage.setCookies): Overriding cc_ut cookies is forbidden"
);
const open = () =>
  openApplicationBrowser({
    applyUrl: "https://job-boards.greenhouse.io/doordashusa/jobs/1",
    executionId: "exec-1",
    scope: { userId: "alice", workspaceId: "workspace:alice" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readState.mockResolvedValue(state);
  mocks.clearState.mockResolvedValue(undefined);
});

describe("opening the application browser", () => {
  it("seeds the saved sign-in state when the browser takes it", async () => {
    mocks.createSession.mockResolvedValue({
      session_id: "browser-1",
      status: "active",
    });
    await expect(open()).resolves.toMatchObject({ session_id: "browser-1" });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession.mock.calls[0]?.[0]).toMatchObject({
      storageState: state,
    });
    expect(mocks.clearState).not.toHaveBeenCalled();
  });

  it("opens a clean browser when the browser refuses the saved cookies, and forgets them", async () => {
    // The DoorDash and Hightouch starts both died here with "Overriding ...
    // cookies is forbidden". A saved state is a convenience; the run is the
    // job, and a blob the browser will not take would fail every run until
    // someone cleared it by hand.
    mocks.createSession
      .mockRejectedValueOnce(cookieError)
      .mockResolvedValueOnce({ session_id: "browser-2", status: "active" });
    await expect(open()).resolves.toMatchObject({ session_id: "browser-2" });
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.createSession.mock.calls[1]?.[0]).not.toHaveProperty(
      "storageState"
    );
    expect(mocks.clearState).toHaveBeenCalledTimes(1);
  });

  it("does not retry any other failure to open a browser", async () => {
    mocks.createSession.mockRejectedValue(
      new Error("Could not connect to the upstream browser")
    );
    await expect(open()).rejects.toThrow(/upstream browser/u);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.clearState).not.toHaveBeenCalled();
  });
});
