import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
} from "@/db/services/browsers";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import type { AccessScope } from "@/lib/access-scope";
import {
  browserProvider,
  isGatewayProvider,
  type BrowserSessionDescriptor,
} from "@/lib/browser";
import type { PlaywrightResponse } from "@/lib/browser/contract";
import {
  readWorkspaceBrowserState,
  saveWorkspaceBrowserState,
} from "@/lib/manager/server/browser-state";
import { ensureKernelBrowserProfile } from "@/lib/manager/server/kernel-profile";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  describeBrowserSessionFailure,
  diagnosticErrorCode,
  forgetDeadBrowserSession,
  isBrowserSessionDead,
} from "@/agent/subagents/worker/lib/challenge-diagnostics";
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

const inputSchema = z
  .object({
    action: z.enum(["create", "list", "get", "delete"]),
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
  })
  .refine(
    (value) =>
      (value.viewport_width === undefined) ===
      (value.viewport_height === undefined),
    { message: "Viewport width and height must be provided together." }
  );

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
        const persistence = await sessionPersistence(scope, signal);
        const browser = await browserProvider.createSession(
          {
            // Workday needs a settled page before its account chooser can be
            // routed safely, so the router performs the navigation itself.
            startUrl: isWorkday ? undefined : input.start_url,
            timeoutSeconds: input.timeout_seconds ?? browserTimeoutFloorSeconds,
            viewport: browserViewport(input),
            ...persistence,
          },
          signal
        );
        try {
          await createBrowserSession(scope, {
            createdAt: browser.created_at ?? new Date().toISOString(),
            sessionId: browser.session_id,
          });
        } catch (error) {
          await browserProvider
            .deleteSession(browser.session_id, signal)
            .catch(() => undefined);
          throw error;
        }
        if (browser.devtools_url) {
          // Operator-facing only: the DevTools inspector grants full page
          // control and dies with the session, so it never reaches the model.
          console.info("[browser-session] devtools inspector available", {
            browser_session_id: browser.session_id,
            devtools_url: browser.devtools_url,
          });
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
              const response = await browserProvider.executePlaywright(
                browser.session_id,
                {
                  code: workdayRouterCode(input.start_url, strategy),
                  timeoutSec: workdayRouteTimeoutSec,
                },
                signal
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
                response,
                sessionId: browser.session_id,
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
              await browserProvider.executePlaywright(
                browser.session_id,
                {
                  code: workdayRestoreCode(input.start_url),
                  timeoutSec: 20,
                },
                signal
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
              const browser = await browserProvider.getSession(
                sessionId,
                { includeDeleted },
                signal
              );
              const value = modelDescriptor(browser);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch (error: unknown) {
              // A session the backend has reclaimed must not linger as a local
              // row: the worker would keep passing its id to tools that all
              // fail.
              if (isBrowserSessionDead(describeBrowserSessionFailure(error))) {
                await forgetDeadBrowserSession(scope, sessionId);
              }
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
        return modelDescriptor(
          await browserProvider.getSession(sessionId, {}, signal)
        );
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        try {
          const { storageState } = await browserProvider.deleteSession(
            sessionId,
            signal
          );
          if (storageState !== undefined) {
            // The gateway hands back signed-in state on close, the way
            // deleting a Kernel browser flushes cookies into its profile.
            await saveWorkspaceBrowserState(scope, storageState).catch(
              (error: unknown) => {
                console.error("[browser-state] persistence failed", {
                  error:
                    error instanceof Error ? error.message : "write failed",
                  workspace_id: scope.workspaceId,
                });
              }
            );
          }
        } catch (error: unknown) {
          // The backend expiring the session first must not leave the local
          // row behind. Deleting something already gone is the outcome asked
          // for.
          if (!isBrowserSessionDead(describeBrowserSessionFailure(error))) {
            throw error;
          }
        }
        await deleteBrowserSession(scope, sessionId);
        return "Browser session deleted successfully";
      }
    }
  },
});

async function sessionPersistence(scope: AccessScope, signal?: AbortSignal) {
  if (isGatewayProvider(browserProvider)) {
    return { storageState: await readWorkspaceBrowserState(scope) };
  }
  return { kernelProfileId: await ensureKernelBrowserProfile(scope, signal) };
}

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

function modelDescriptor(browser: BrowserSessionDescriptor) {
  return {
    ...(browser.browser_live_view_url === undefined
      ? {}
      : { browser_live_view_url: browser.browser_live_view_url }),
    session_id: browser.session_id,
    status: browser.status === "deleted" ? "deleted" : "active",
    viewport: browser.viewport,
  };
}

function lifecycleResult(
  browser: BrowserSessionDescriptor,
  workday?: ReturnType<typeof normalizeWorkdayRouteResult>
) {
  const value = modelDescriptor(browser);
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
      `Use solve_captcha with session_id "${value.session_id}" immediately if the managed solver reports a visible hCaptcha it could not solve automatically, a checkbox remains, or a lookalike image-selection grid is visible. solve_captcha clicks tiles and writes a lookalike response token; do not request a takeover.`,
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
  response,
  sessionId,
  workday,
}: {
  applicationUrl: string;
  response: PlaywrightResponse;
  sessionId: string;
  workday: ReturnType<typeof normalizeWorkdayRouteResult>;
}) {
  const detail = {
    actions: workday.actions ?? [],
    attempt: workday.attempt,
    browser_session_id: sessionId,
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

function safeWorkdayLocation(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
