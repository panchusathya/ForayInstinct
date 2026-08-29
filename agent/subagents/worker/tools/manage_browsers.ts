import type {
  BrowserCreateResponse,
  BrowserRetrieveResponse,
  BrowserUpdateResponse,
} from "@onkernel/sdk/resources/browsers";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
} from "@/db/services/browsers";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import type { AccessScope } from "@/lib/access-scope";
import { env } from "@/lib/env";
import { kernel } from "@/lib/kernel";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  isWorkdayApplicationUrl,
  normalizeWorkdayRouteResult,
  workdayRouterCode,
  workdayRouteStrategies,
} from "@/agent/subagents/worker/lib/workday-router";

const browserTimeoutFloorSeconds = 15 * 60;

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(259_200)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export default defineTool({
  description:
    'Manage browser sessions. Create one browser and reuse it for the assignment; use "list" or "get" to inspect sessions and "delete" when finished. Keep a browser open only for a pending human action or transaction approval.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const signal = context.abortSignal;

    switch (input.action) {
      case "create": {
        const isWorkday =
          input.start_url !== undefined &&
          isWorkdayApplicationUrl(input.start_url);
        const browser = await kernel.browsers.create(
          {
            // Kernel start_url navigation is fire-and-forget. Workday needs a
            // settled page before its account chooser can be routed safely.
            start_url: isWorkday ? undefined : input.start_url,
            stealth: true,
            timeout_seconds:
              input.timeout_seconds ?? browserTimeoutFloorSeconds,
            viewport: browserViewport(input),
            ...(env.KERNEL_PROXY_ID === undefined
              ? {}
              : { proxy: { id: env.KERNEL_PROXY_ID } }),
          },
          { signal }
        );
        try {
          await createBrowserSession(scope, {
            createdAt: browser.created_at,
            sessionId: browser.session_id,
          });
        } catch (error) {
          await kernel.browsers
            .deleteByID(browser.session_id, { signal })
            .catch(() => undefined);
          throw error;
        }
        await recordCheckpoint(scope, browser.session_id, {
          action: "create",
          page: safeWorkdayLocation(input.start_url),
          phase: "browser",
          state: "created",
        });
        let workday: ReturnType<typeof normalizeWorkdayRouteResult> | undefined;
        if (isWorkday && input.start_url) {
          console.info("[workday-router] browser created", {
            browser_session_id: browser.session_id,
            target: safeWorkdayLocation(input.start_url),
          });
          try {
            for (const [index, strategy] of workdayRouteStrategies.entries()) {
              const response = await kernel.browsers.playwright.execute(
                browser.session_id,
                {
                  code: workdayRouterCode(input.start_url, strategy),
                  timeout_sec: 30,
                },
                { signal }
              );
              workday = {
                ...normalizeWorkdayRouteResult(response),
                attempt: index + 1,
                strategy,
              };
              await recordCheckpoint(scope, browser.session_id, {
                action: strategy,
                actions: workday.actions,
                attempt: index + 1,
                errorCode: diagnosticErrorCode(response.error),
                page: safeWorkdayLocation(workday.url),
                phase: "workday_router",
                state: workday.state,
                trace: workday.trace,
              });
              logWorkdayRoute({
                applicationUrl: input.start_url,
                browser,
                response,
                workday,
              });
              if (workday.state !== "route_incomplete") break;
            }
          } catch (error) {
            await recordCheckpoint(scope, browser.session_id, {
              action: workday?.strategy,
              attempt: workday?.attempt,
              errorCode: diagnosticErrorCode(error),
              page: safeWorkdayLocation(input.start_url),
              phase: "workday_router",
              state: "execution_failed",
            });
            console.error("[workday-router] route request failed", {
              browser_session_id: browser.session_id,
              error_code: diagnosticErrorCode(error),
              target: safeWorkdayLocation(input.start_url),
            });
            throw error;
          }
        }
        return lifecycleResult(browser, workday);
      }
      case "list": {
        const records = await listBrowserSessions(scope);
        const includeDeleted = input.status !== "active";
        const browsers = await Promise.all(
          records.map(async ({ sessionId }) => {
            try {
              const browser = await kernel.browsers.retrieve(
                sessionId,
                { include_deleted: includeDeleted },
                { signal }
              );
              const value = browserDescriptor(browser);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch {
              return null;
            }
          })
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          has_more: false,
          items: browsers
            .filter((browser) => browser !== null)
            .slice(offset, offset + limit),
          next_offset: null,
        };
      }
      case "get": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        return browserDescriptor(
          await kernel.browsers.retrieve(sessionId, {}, { signal })
        );
      }
      case "update": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        const viewport = browserViewport(input);
        const browser = viewport
          ? await kernel.browsers.update(sessionId, { viewport }, { signal })
          : await kernel.browsers.retrieve(sessionId, {}, { signal });
        return lifecycleResult(browser);
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        await kernel.browsers.deleteByID(sessionId, { signal });
        await deleteBrowserSession(scope, sessionId);
        return "Browser session deleted successfully";
      }
    }
  },
});

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

type KernelBrowser =
  | BrowserCreateResponse
  | BrowserRetrieveResponse
  | BrowserUpdateResponse;

function browserDescriptor(browser: KernelBrowser) {
  return {
    browser_live_view_url: browser.browser_live_view_url,
    session_id: browser.session_id,
    status: browser.deleted_at ? "deleted" : "active",
    viewport: browser.viewport ?? undefined,
  };
}

function lifecycleResult(
  browser: KernelBrowser,
  workday?: ReturnType<typeof normalizeWorkdayRouteResult>
) {
  const value = browserDescriptor(browser);
  return {
    browser: value,
    next_actions: [
      ...(workday?.state === "email_login_ready"
        ? [
            "Workday is at its real email/password form. Use list_vault, focus that form, then use fill_from_vault; do not click a header Sign In control.",
          ]
        : []),
      ...(workday?.state === "route_incomplete"
        ? [
            "Workday routing completed its direct, reload, and direct-autofill retries without finding a safe next control. Continue autonomously with one observed Playwright inspection/recovery; do not request human takeover unless a required answer, OTP, or personal verification is actually present.",
          ]
        : []),
      `Use execute_playwright_code with session_id "${value.session_id}" for deterministic browser automation.`,
      `Use computer_action with session_id "${value.session_id}" for visual browser control.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
    ...(workday === undefined ? {} : { workday }),
  };
}

function logWorkdayRoute({
  applicationUrl,
  browser,
  response,
  workday,
}: {
  applicationUrl: string;
  browser: KernelBrowser;
  response: Awaited<ReturnType<typeof kernel.browsers.playwright.execute>>;
  workday: ReturnType<typeof normalizeWorkdayRouteResult>;
}) {
  const detail = {
    actions: workday.actions ?? [],
    attempt: workday.attempt,
    browser_session_id: browser.session_id,
    execution_error: diagnosticErrorCode(response.error),
    execution_success: response.success,
    page: safeWorkdayLocation(workday.url),
    state: workday.state,
    strategy: workday.strategy,
    target: safeWorkdayLocation(applicationUrl),
    trace: workday.trace ?? [],
  };
  if (response.success) {
    console.info("[workday-router] route completed", detail);
  } else {
    console.error("[workday-router] route execution failed", detail);
  }
}

async function recordCheckpoint(
  scope: AccessScope,
  sessionId: string,
  checkpoint: Parameters<typeof recordBrowserRunCheckpoint>[2]
) {
  try {
    await recordBrowserRunCheckpoint(scope, sessionId, checkpoint);
  } catch (error) {
    console.error("[browser-checkpoint] persistence failed", {
      error_code: diagnosticErrorCode(error),
      phase: checkpoint.phase,
      session_id: sessionId,
    });
  }
}

function diagnosticErrorCode(error: unknown) {
  if (typeof error !== "string" && !(error instanceof Error)) return undefined;
  const message = typeof error === "string" ? error : error.message;
  if (/timeout/i.test(message)) return "timeout";
  if (/chrome-error|net::/i.test(message)) return "navigation";
  if (/selector|locator/i.test(message)) return "selector";
  return "playwright_execution";
}

function safeWorkdayLocation(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
