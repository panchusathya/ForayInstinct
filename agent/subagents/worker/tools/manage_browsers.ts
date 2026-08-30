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
import { ensureKernelBrowserProfile } from "@/lib/manager/server/kernel-profile";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  isResolvedWorkdayRoute,
  isWorkdayApplicationUrl,
  normalizeWorkdayRouteResult,
  workdayRestoreCode,
  workdayRouterCode,
  workdayRouteRank,
  workdayRouteStrategies,
  workdayRouteTimeoutSec,
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
        const profileId = await ensureKernelBrowserProfile(scope, signal);
        const browser = await kernel.browsers.create(
          {
            // Kernel start_url navigation is fire-and-forget. Workday needs a
            // settled page before its account chooser can be routed safely.
            start_url: isWorkday ? undefined : input.start_url,
            stealth: true,
            telemetry: { enabled: true },
            timeout_seconds:
              input.timeout_seconds ?? browserTimeoutFloorSeconds,
            viewport: browserViewport(input),
            ...(profileId === undefined
              ? {}
              : { profile: { id: profileId, save_changes: true } }),
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
        let attemptedAutofillPath = false;
        if (isWorkday && input.start_url) {
          console.info("[workday-router] browser created", {
            browser_session_id: browser.session_id,
            target: safeWorkdayLocation(input.start_url),
          });
          for (const [index, strategy] of workdayRouteStrategies.entries()) {
            if (strategy === "autofill_path") attemptedAutofillPath = true;
            const attempt = index + 1;
            let candidate: ReturnType<typeof normalizeWorkdayRouteResult>;
            try {
              const response = await kernel.browsers.playwright.execute(
                browser.session_id,
                {
                  code: workdayRouterCode(input.start_url, strategy),
                  timeout_sec: workdayRouteTimeoutSec,
                },
                { signal }
              );
              candidate = {
                ...normalizeWorkdayRouteResult(response),
                attempt,
                strategy,
              };
              await recordCheckpoint(scope, browser.session_id, {
                action: strategy,
                actions: candidate.actions,
                attempt,
                errorCode: diagnosticErrorCode(response.error),
                page: safeWorkdayLocation(candidate.url),
                phase: "workday_router",
                state: candidate.state,
                trace: candidate.trace,
              });
              logWorkdayRoute({
                applicationUrl: input.start_url,
                browser,
                response,
                workday: candidate,
              });
            } catch (error) {
              // A cancelled assignment must stop here; anything else is one
              // strategy failing, which the remaining strategies can recover.
              if (signal.aborted) throw error;
              candidate = { attempt, state: "execution_failed", strategy };
              await recordCheckpoint(scope, browser.session_id, {
                action: strategy,
                attempt,
                errorCode: diagnosticErrorCode(error),
                page: safeWorkdayLocation(input.start_url),
                phase: "workday_router",
                state: "execution_failed",
              });
              console.error("[workday-router] route request failed", {
                attempt,
                browser_session_id: browser.session_id,
                error_code: diagnosticErrorCode(error),
                strategy,
                target: safeWorkdayLocation(input.start_url),
              });
            }
            // Keep the most informative read: a later timeout must not bury an
            // earlier attempt that actually observed the page. Equally ranked
            // results prefer the latest, which is where the browser now sits.
            if (
              workday === undefined ||
              workdayRouteRank(candidate.state) >=
                workdayRouteRank(workday.state)
            ) {
              workday = candidate;
            }
            if (isResolvedWorkdayRoute(candidate.state)) break;
          }
          if (
            attemptedAutofillPath &&
            workday !== undefined &&
            !isResolvedWorkdayRoute(workday.state)
          ) {
            try {
              await kernel.browsers.playwright.execute(
                browser.session_id,
                {
                  code: workdayRestoreCode(input.start_url),
                  timeout_sec: 20,
                },
                { signal }
              );
            } catch (error) {
              if (signal.aborted) throw error;
              console.error("[workday-router] autofill path restore failed", {
                browser_session_id: browser.session_id,
                error_code: diagnosticErrorCode(error),
                target: safeWorkdayLocation(input.start_url),
              });
            }
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
        const items = browsers.filter((browser) => browser !== null);
        const page = items.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          has_more: nextOffset < items.length,
          items: page,
          next_offset: nextOffset < items.length ? nextOffset : null,
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
      ...(workday === undefined ? [] : [workdayNextAction(workday.state)]),
      ...(workday?.today === undefined
        ? []
        : [
            `Use workday.today (${workday.today.isoDate}, ${workday.today.timeZone}) for signature and date fields; it is the browser's own date.`,
          ]),
      `Use execute_playwright_code with session_id "${value.session_id}" for deterministic browser automation.`,
      `Use computer_action with session_id "${value.session_id}" for visual browser control.`,
      `Use solve_captcha with session_id "${value.session_id}" immediately if Kernel reports visible hCaptcha could not be solved automatically or a checkbox hCaptcha remains.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
    ...(workday === undefined ? {} : { workday }),
  };
}

const workdayNextActions: Record<
  NonNullable<ReturnType<typeof normalizeWorkdayRouteResult>>["state"],
  string
> = {
  email_login_ready:
    "Workday is at its real email/password form. Use list_vault, focus that form, then use fill_from_vault; do not click a header Sign In control.",
  account_creation_ready:
    "Workday is offering create-account with no reachable sign-in switch. Call list_vault; if no login exists for this origin, call provision_login, then focus the create-account form and fill_from_vault with purpose sign_up. Do not pass origin, identifier, or password. Then continue the application.",
  wizard_ready:
    "Workday is already inside the application wizard. Continue filling the current step with execute_playwright_code; do not navigate back to the job posting or re-enter the account wall.",
  route_incomplete:
    "Workday routing completed its direct, reload, and direct-autofill retries without finding a safe next control. Continue autonomously with one observed Playwright inspection/recovery; do not request human takeover unless a required answer, OTP, or personal verification is actually present.",
  error_shell:
    "Workday returned an error or maintenance page, so the tenant is unavailable rather than misrouted. Reload once with execute_playwright_code; if it still shows the outage, report the outage and stop instead of retrying the application.",
  navigation_failed:
    "The job page never loaded. Retry the navigation once with execute_playwright_code before drawing any conclusion; report an unreachable posting only if that retry also fails.",
  execution_failed:
    "Routing could not run to completion, which says nothing about the page itself. Inspect the current page with execute_playwright_code and continue the application from whatever it shows.",
};

function workdayNextAction(
  state: ReturnType<typeof normalizeWorkdayRouteResult>["state"]
) {
  return workdayNextActions[state];
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
    timeZone: workday.today?.timeZone,
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
  if (/407|proxy.*auth|wrong_password|auth failed/i.test(message)) {
    return "proxy_auth";
  }
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
