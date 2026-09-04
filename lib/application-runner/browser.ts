import { createBrowserSession } from "@/db/services/browsers";
import { attachBrowserToApplicationExecution } from "@/db/services/application-executions";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import type { AccessScope } from "@/lib/access-scope";
import { applicationExecutionLog } from "@/lib/application-execution";
import { browserProvider, isGatewayProvider } from "@/lib/browser";
import { isCookieSeedFailure } from "@/lib/browser/storage-state";
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
import {
  clearWorkspaceBrowserState,
  readWorkspaceBrowserState,
  saveWorkspaceBrowserState,
} from "@/lib/manager/server/browser-state";
import { ensureKernelBrowserProfile } from "@/lib/manager/server/kernel-profile";

const browserTimeoutFloorSeconds = 15 * 60;

export async function openApplicationBrowser(input: {
  applyUrl: string;
  executionId: string;
  scope: AccessScope;
  signal?: AbortSignal;
}) {
  const isWorkday = isWorkdayApplicationUrl(input.applyUrl);
  const persistence = isGatewayProvider(browserProvider)
    ? { storageState: await readWorkspaceBrowserState(input.scope) }
    : {
        kernelProfileId: await ensureKernelBrowserProfile(
          input.scope,
          input.signal
        ),
      };
  const session = {
    startUrl: isWorkday ? undefined : input.applyUrl,
    timeoutSeconds: browserTimeoutFloorSeconds,
  };
  let browser;
  try {
    browser = await browserProvider.createSession(
      { ...session, ...persistence },
      input.signal
    );
  } catch (error) {
    // The saved sign-in state is a convenience; the application is the job.
    // A blob the browser refused to seed ("Overriding ... cookies is
    // forbidden") killed every run for the workspace, DoorDash and Hightouch
    // alike, at the moment the browser was opened. Drop it and open a clean
    // browser: the state is rebuilt from whatever this session signs into.
    if (!("storageState" in persistence) || !isCookieSeedFailure(error)) {
      throw error;
    }
    applicationExecutionLog({
      error: (error instanceof Error ? error.message : "unknown").slice(0, 300),
      event: "browser.state_rejected",
      execution_id: input.executionId,
    });
    await clearWorkspaceBrowserState(input.scope).catch(() => undefined);
    browser = await browserProvider.createSession(session, input.signal);
  }
  try {
    await createBrowserSession(input.scope, {
      createdAt: browser.created_at ?? new Date().toISOString(),
      sessionId: browser.session_id,
    });
  } catch (error) {
    await browserProvider
      .deleteSession(browser.session_id, input.signal)
      .catch(() => undefined);
    throw error;
  }
  await attachBrowserToApplicationExecution(
    input.scope,
    browser.session_id,
    undefined,
    input.executionId
  ).catch(() => undefined);
  await recordBrowserRunCheckpoint(input.scope, browser.session_id, {
    action: "create",
    executionId: input.executionId,
    page: input.applyUrl,
    phase: "browser",
    state: "created",
  }).catch(() => undefined);
  if (isWorkday) {
    await routeWorkday(browser.session_id, input.applyUrl, input.signal);
  }
  return browser;
}

export async function closeApplicationBrowser(input: {
  scope: AccessScope;
  sessionId: string;
  signal?: AbortSignal;
}) {
  try {
    const { storageState } = await browserProvider.deleteSession(
      input.sessionId,
      input.signal
    );
    if (storageState !== undefined) {
      await saveWorkspaceBrowserState(input.scope, storageState).catch(
        () => undefined
      );
    }
  } catch {
    // Session already gone is the outcome we wanted.
  }
}

async function routeWorkday(
  sessionId: string,
  applyUrl: string,
  signal?: AbortSignal
) {
  let best: ReturnType<typeof normalizeWorkdayRouteResult> | undefined;
  for (const strategy of workdayRouteStrategies) {
    const response = await browserProvider.executePlaywright(
      sessionId,
      {
        code: workdayRouterCode(applyUrl, strategy),
        timeoutSec: workdayRouteTimeoutSec,
      },
      signal
    );
    const candidate = normalizeWorkdayRouteResult(response);
    if (
      best === undefined ||
      workdayRouteRank(candidate.state) >= workdayRouteRank(best.state)
    ) {
      best = candidate;
    }
    if (isResolvedWorkdayRoute(best.state)) break;
  }
  if (best && !isResolvedWorkdayRoute(best.state)) {
    await browserProvider
      .executePlaywright(
        sessionId,
        { code: workdayRestoreCode(applyUrl) },
        signal
      )
      .catch(() => undefined);
  }
}
