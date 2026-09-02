import { createBrowserSession } from "@/db/services/browsers";
import { attachBrowserToApplicationExecution } from "@/db/services/application-executions";
import { recordBrowserRunCheckpoint } from "@/db/services/browser-run-checkpoints";
import type { AccessScope } from "@/lib/access-scope";
import { browserProvider, isGatewayProvider } from "@/lib/browser";
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
  const browser = await browserProvider.createSession(
    {
      startUrl: isWorkday ? undefined : input.applyUrl,
      timeoutSeconds: browserTimeoutFloorSeconds,
      ...persistence,
    },
    input.signal
  );
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
