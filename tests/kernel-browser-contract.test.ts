import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import manageBrowsers from "../agent/subagents/worker/tools/manage_browsers";
import { workdayRouterCode } from "../agent/subagents/worker/lib/workday-router";

const mocks = vi.hoisted(() => ({
  createBrowser: vi.fn<
    (
      _input: unknown,
      _options: unknown
    ) => Promise<{
      browser_live_view_url: string;
      created_at: string;
      deleted_at: null;
      session_id: string;
      viewport: null;
    }>
  >(),
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _input: unknown,
        _options: unknown
      ) => Promise<unknown>
    >(),
  createBrowserSession:
    vi.fn<(_scope: unknown, _record: unknown) => Promise<void>>(),
  recordBrowserRunCheckpoint:
    vi.fn<
      (
        _scope: unknown,
        _sessionId: string,
        _checkpoint: unknown
      ) => Promise<void>
    >(),
  kernelProxyId: undefined as string | undefined,
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

vi.mock("@/db/services/browser-run-checkpoints", () => ({
  recordBrowserRunCheckpoint: mocks.recordBrowserRunCheckpoint,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      create: mocks.createBrowser,
      playwright: { execute: mocks.executePlaywright },
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    get KERNEL_PROXY_ID() {
      return mocks.kernelProxyId;
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kernelProxyId = undefined;
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.createBrowser.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1",
    created_at: "2026-08-27T00:00:00.000Z",
    deleted_at: null,
    session_id: "browser-1",
    viewport: null,
  });
  mocks.executePlaywright.mockResolvedValue({
    success: true,
    result: {
      state: "email_login_ready",
      url: "https://tenant.myworkdayjobs.com/login",
    },
  });
});

describe("Kernel browser contract", () => {
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

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; create only reads abortSignal after the mocked authorization boundary.
    const result = await execute({ action: "create" }, {} as never);
    expect(result).toMatchObject({
      browser: {
        browser_live_view_url: "https://live.kernel.test/browser-1",
      },
    });
    if (
      typeof result !== "object" ||
      !("next_actions" in result) ||
      !Array.isArray(result.next_actions)
    ) {
      throw new Error("manage_browsers create must return next_actions.");
    }
    expect(
      result.next_actions.some(
        (action) =>
          typeof action === "string" && action.includes("solve_captcha")
      )
    ).toBe(true);

    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      {
        start_url: undefined,
        stealth: true,
        timeout_seconds: 900,
        viewport: undefined,
      },
      { signal: undefined }
    );
  });

  it("attaches KERNEL_PROXY_ID while keeping stealth", async () => {
    mocks.kernelProxyId = "proxy-us-residential";
    const execute = manageBrowsers.execute;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; create only reads abortSignal after the mocked authorization boundary.
    await execute({ action: "create" }, {} as never);

    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      {
        start_url: undefined,
        stealth: true,
        timeout_seconds: 900,
        viewport: undefined,
        proxy: { id: "proxy-us-residential" },
      },
      { signal: undefined }
    );
  });

  it("routes Workday with a settled Playwright navigation instead of start_url", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const execute = manageBrowsers.execute;

    const input = {
      action: "create" as const,
      start_url: "https://tenant.myworkdayjobs.com/en-US/job/example",
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; create only reads abortSignal after the mocked authorization boundary.
    const result = await execute(input, {} as never);

    expect(mocks.createBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ start_url: undefined, stealth: true }),
      { signal: undefined }
    );
    expect(mocks.executePlaywright).toHaveBeenCalledWith(
      "browser-1",
      expect.objectContaining({ timeout_sec: 30 }),
      { signal: undefined }
    );
    expect(
      workdayRouterCode("https://tenant.myworkdayjobs.com/en-US/job/example")
    ).toContain("SignInWithEmailButton");
    expect(
      workdayRouterCode("https://tenant.myworkdayjobs.com/en-US/job/example")
    ).toContain('a[data-automation-id="adventureButton"]');
    expect(
      workdayRouterCode("https://tenant.myworkdayjobs.com/en-US/job/example")
    ).toContain("sign_in:initial_link");
    expect(result).toMatchObject({
      workday: {
        attempt: 1,
        state: "email_login_ready",
        strategy: "direct",
      },
    });
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        phase: "workday_router",
        state: "email_login_ready",
      })
    );
    expect(info).toHaveBeenCalledWith(
      "[workday-router] browser created",
      expect.objectContaining({
        browser_session_id: "browser-1",
        target: "https://tenant.myworkdayjobs.com/en-US/job/example",
      })
    );
    expect(info).toHaveBeenCalledWith(
      "[workday-router] route completed",
      expect.objectContaining({
        execution_success: true,
        state: "email_login_ready",
      })
    );
  });

  it("retries incomplete Workday routes with bounded recovery strategies", async () => {
    mocks.executePlaywright.mockResolvedValue({
      success: true,
      result: { actions: ["Sign In"], state: "route_incomplete" },
    });
    const execute = manageBrowsers.execute;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; create only reads abortSignal after the mocked authorization boundary.
    const result = await execute(
      {
        action: "create",
        start_url: "https://tenant.myworkdayjobs.com/en-US/job/example",
      },
      {} as never
    );

    expect(mocks.executePlaywright).toHaveBeenCalledTimes(3);
    expect(
      mocks.executePlaywright.mock.calls.map(([, input]) => input)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining('"direct"') }),
        expect.objectContaining({ code: expect.stringContaining('"reload"') }),
        expect.objectContaining({
          code: expect.stringContaining("autofillWithResume"),
        }),
      ])
    );
    expect(result).toMatchObject({
      workday: {
        attempt: 3,
        state: "route_incomplete",
        strategy: "autofill_path",
      },
    });
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledTimes(4);
  });
});
