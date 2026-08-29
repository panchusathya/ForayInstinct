import { runInThisContext, Script } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import manageBrowsers from "../agent/subagents/worker/tools/manage_browsers";
import {
  workdayRouterCode,
  workdayRouteStrategies,
  workdayRouteTimeoutSec,
} from "../agent/subagents/worker/lib/workday-router";

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

// The Eve tool context is external runtime state; create only reads abortSignal
// after the mocked authorization boundary.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
const toolContext = {} as never;

const jobUrl = "https://tenant.myworkdayjobs.com/en-US/job/example";

function stubPage({
  bodyText = "",
  redirectTo,
  url,
  visible = [],
}: {
  bodyText?: string;
  redirectTo?: string;
  url: string;
  visible?: string[];
}) {
  let current = url;
  const shown = (selector: string) =>
    visible.some((entry) => selector.includes(entry));
  const locator = (selector: string) => {
    const self = {
      click: async () => undefined,
      evaluateAll: async () => [],
      first: () => self,
      innerText: async () => (selector === "body" ? bodyText : ""),
      isVisible: async () => shown(selector),
      waitFor: async () => {
        if (!shown(selector)) throw new Error(`not visible: ${selector}`);
      },
    };
    return self;
  };
  return {
    getByRole: (_role: string, options?: { name?: RegExp }) =>
      locator(String(options?.name ?? "")),
    goto: async (target: string) => {
      current = redirectTo ?? target;
      return {};
    },
    locator,
    reload: async () => ({}),
    url: () => current,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  };
}

async function routeAgainst(page: Parameters<typeof stubPage>[0]) {
  const code = workdayRouterCode(page.url);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runInThisContext compiles the snippet Kernel runs, so its type is only knowable here.
  const run = runInThisContext(`(page) => (async () => {${code}})()`) as (
    _page: ReturnType<typeof stubPage>
  ) => Promise<unknown>;
  return run(stubPage(page));
}

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
        telemetry: { enabled: true },
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
        telemetry: { enabled: true },
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
      expect.objectContaining({ timeout_sec: workdayRouteTimeoutSec }),
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

  it("keeps routing after a strategy times out instead of abandoning recovery", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.executePlaywright
      .mockResolvedValueOnce({
        success: false,
        error: "timeout of 75s exceeded",
      })
      .mockResolvedValueOnce({
        success: true,
        result: { state: "email_login_ready", trace: ["navigation:loaded"] },
      });
    const execute = manageBrowsers.execute;

    const result = await execute(
      {
        action: "create",
        start_url: "https://tenant.myworkdayjobs.com/en-US/job/example",
      },
      toolContext
    );

    // The timed-out first strategy must not be reported as a failed navigation,
    // and must not stop the strategy that recovers the route.
    expect(mocks.executePlaywright).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      workday: { attempt: 2, state: "email_login_ready", strategy: "reload" },
    });
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        attempt: 1,
        errorCode: "timeout",
        state: "execution_failed",
      })
    );
    error.mockRestore();
  });

  it("reports the most informative route when a later strategy fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.executePlaywright
      .mockResolvedValueOnce({
        success: true,
        result: { actions: ["Sign In"], state: "route_incomplete" },
      })
      .mockResolvedValue({ success: false, error: "timeout" });
    const execute = manageBrowsers.execute;

    const result = await execute(
      {
        action: "create",
        start_url: "https://tenant.myworkdayjobs.com/en-US/job/example",
      },
      toolContext
    );

    expect(result).toMatchObject({
      workday: { attempt: 1, state: "route_incomplete", strategy: "direct" },
    });
  });

  it("guides the agent for every routed Workday state", async () => {
    mocks.executePlaywright.mockResolvedValue({
      success: true,
      result: { state: "wizard_ready" },
    });
    const execute = manageBrowsers.execute;

    const result = await execute(
      {
        action: "create",
        start_url: "https://tenant.myworkdayjobs.com/en-US/job/example",
      },
      toolContext
    );

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
          typeof action === "string" &&
          action.includes("already inside the application wizard")
      )
    ).toBe(true);
  });

  it("generates a router script Kernel can parse for every strategy", () => {
    for (const strategy of workdayRouteStrategies) {
      const code = workdayRouterCode(
        "https://tenant.myworkdayjobs.com/en-US/job/example",
        strategy
      );

      // Kernel runs the snippet inside an async function with `page` in scope.
      // A syntax error here is invisible until it fails a live application, so
      // compile it without running it.
      expect(() => new Script(`(async () => {${code}})()`)).not.toThrow();
    }
  });

  it("treats an off-tenant maintenance redirect as an outage", async () => {
    const state = await routeAgainst({
      redirectTo: "https://community.workday.com/maintenance-page",
      url: jobUrl,
    });

    expect(state).toMatchObject({ state: "error_shell" });
  });

  it("does not mistake a maintenance job title for an outage", async () => {
    // Workday puts the job title in the path, so matching the whole URL for
    // "maintenance" would fail every posting for a maintenance role.
    const state = await routeAgainst({
      url: "https://tenant.myworkdayjobs.com/en-US/job/US-CA/Maintenance-Technician_R123",
      visible: ['input[type="password"]'],
    });

    expect(state).toMatchObject({ state: "email_login_ready" });
  });

  it("does not offer a create-account panel to vault autofill", async () => {
    // The signup panel renders a password box too; filling it can never
    // complete a sign-in.
    const state = await routeAgainst({
      url: jobUrl,
      visible: ['input[type="password"]', "verifyPassword"],
    });

    expect(state).toMatchObject({ state: "route_incomplete" });
  });

  it("waits for Workday hydration and bounds itself to a budget", () => {
    const code = workdayRouterCode(
      "https://tenant.myworkdayjobs.com/en-US/job/example"
    );

    // Workday paints its controls after domcontentloaded; routing an empty
    // shell was what produced traces with no observed actions at all.
    expect(code).toContain("hydration:ready");
    expect(code).toContain("budget:exhausted");
    // The create-account panel must never be reported as a fillable login form.
    expect(code).toContain("verifyPassword");
  });
});
