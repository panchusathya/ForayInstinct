import type { PlaywrightExecuteResponse } from "@onkernel/sdk/resources/browsers";

export type WorkdayRouteState =
  | "email_login_ready"
  | "wizard_ready"
  | "error_shell"
  | "navigation_failed"
  | "execution_failed"
  | "route_incomplete";

export const workdayRouteStrategies = [
  "direct",
  "reload",
  "autofill_path",
] as const;

export type WorkdayRouteStrategy = (typeof workdayRouteStrategies)[number];

export interface WorkdayRouteResult {
  actions?: string[];
  attempt?: number;
  state: WorkdayRouteState;
  strategy?: WorkdayRouteStrategy;
  trace?: string[];
  url?: string;
}

/**
 * Matches Workday's Apply / Apply Now / Apply for this job labels without
 * taking "Apply with LinkedIn" or other social apply controls.
 */
export const workdayApplyControlName =
  /^apply(?:\s+now|\s+for this job)?$/i;

/**
 * The router script must finish inside its own budget and return a structured
 * state. Kernel killing the execution instead yields no trace at all, which is
 * why the in-script deadline is shorter than the request timeout.
 */
const routeBudgetMs = 55_000;
export const workdayRouteTimeoutSec = 75;
const maxRouteClicks = 8;
const maxRouteIterations = 24;

const routeStateRank: Record<WorkdayRouteState, number> = {
  email_login_ready: 5,
  wizard_ready: 5,
  route_incomplete: 3,
  error_shell: 2,
  navigation_failed: 1,
  execution_failed: 0,
};

/** A resolved route is the only reason to stop trying the remaining strategies. */
export function isResolvedWorkdayRoute(state: WorkdayRouteState): boolean {
  return state === "email_login_ready" || state === "wizard_ready";
}

/** Ranks how much a result tells us, so a late failure cannot bury an earlier read. */
export function workdayRouteRank(state: WorkdayRouteState): number {
  return routeStateRank[state];
}

/**
 * Workday's account wall is predictable enough to route deterministically.
 * This deliberately stops before credentials are needed: native vault autofill
 * remains the only path that can enter a saved login.
 */
export function isWorkdayApplicationUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "myworkdayjobs.com" ||
      hostname.endsWith(".myworkdayjobs.com")
    );
  } catch {
    return false;
  }
}

export function workdayRouterCode(
  applicationUrl: string,
  strategy: WorkdayRouteStrategy = "direct"
): string {
  return `
const applicationUrl = ${JSON.stringify(workdayRouteUrl(applicationUrl, strategy))};
const strategy = ${JSON.stringify(strategy)};
const deadline = Date.now() + ${JSON.stringify(routeBudgetMs)};
const remaining = () => Math.max(0, deadline - Date.now());
// Every wait is clamped to the budget so one slow step cannot starve the rest.
const cap = (ms) => Math.max(250, Math.min(ms, remaining()));
const applyName = ${workdayApplyControlName};
const trace = [];
const tried = new Set();
const failedOnce = new Set();
const availableActions = async () => page.locator("a, button").evaluateAll((nodes) => nodes
  .map((node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
  .filter((label) => /apply|continue|sign in|create account/i.test(label))
  .slice(0, 12)
).catch(() => []);
const visible = async (locator) => locator.first().isVisible().catch(() => false);
const dialogLocator = () => page.locator('[role="dialog"], [aria-modal="true"]');
const scopedRoot = async () => (await visible(dialogLocator()) ? dialogLocator() : page);
const settleAfterClick = async () => {
  const started = page.url();
  // Workday is a SPA: domcontentloaded never fires on a view swap, so race a
  // URL change or dialog appearance against a short timeout instead.
  await Promise.race([
    page.waitForURL((url) => String(url) !== started, { timeout: cap(1500) }).catch(() => undefined),
    dialogLocator().first().waitFor({ state: "visible", timeout: cap(1500) }).catch(() => undefined),
    page.waitForTimeout(cap(1500)),
  ]);
};
const click = async (step, locator) => {
  // Only a click that actually landed is burned. An intercepted or timed-out
  // click gets one retry; a success that did not advance still must not repeat.
  if (tried.has(step)) return false;
  if (!(await visible(locator))) return false;
  const clicked = await locator.first().click({ timeout: cap(5000) }).then(() => true).catch(() => false);
  if (!clicked) {
    if (failedOnce.has(step)) tried.add(step);
    else failedOnce.add(step);
    return false;
  }
  tried.add(step);
  await settleAfterClick();
  trace.push(step);
  return true;
};
const signupOnly = async () => visible(page.locator('input[data-automation-id="verifyPassword"], input[data-automation-id="verifyNewPassword"]'));
const postingApplyVisible = async () => (
  await visible(page.locator('a[data-automation-id="adventureButton"], button[data-automation-id="adventureButton"]'))
  || await visible(page.locator('[data-automation-id="applyManually"]'))
  || await visible(page.getByRole("button", { name: /^apply manually$/i }))
  || await visible(page.getByRole("link", { name: /^apply manually$/i }))
  || await visible(page.getByRole("button", { name: /^continue application$/i }))
  || await visible(page.getByRole("link", { name: /^continue application$/i }))
  || await visible(page.getByRole("button", { name: applyName }))
  || await visible(page.getByRole("link", { name: applyName }))
);
const inWallPhase = async () => {
  if (await visible(dialogLocator())) return true;
  if (await signupOnly()) return true;
  return !(await postingApplyVisible());
};
const jobsHost = new URL(applicationUrl).hostname;
const offTenantOutage = (value) => {
  try {
    const here = new URL(value);
    return here.hostname !== jobsHost && /maintenance|unavailable/i.test(here.pathname);
  } catch {
    return false;
  }
};
const currentState = async () => {
  const url = page.url();
  if (url.startsWith("chrome-error://")) return { state: "navigation_failed", trace, url };
  // A tenant outage redirects off the jobs host entirely. Matching the path
  // alone would flag a real posting, since Workday puts the job title in the
  // URL and plenty of them are maintenance roles.
  if (offTenantOutage(url)) return { state: "error_shell", trace, url };
  const body = await page.locator("body").innerText({ timeout: cap(3000) }).catch(() => "");
  if (/something went wrong|unexpected error|we're sorry|try again later|under maintenance|temporarily unavailable/i.test(body)) {
    return { state: "error_shell", trace, url };
  }
  // Workday's create-account panel renders a password box too. Reporting it as
  // a login form sends vault autofill into a signup it can never complete.
  if (await signupOnly()) return null;
  if (await visible(page.locator('input[type="password"], input[data-automation-id="password"]'))) {
    return { state: "email_login_ready", trace, url };
  }
  if (await visible(page.locator('[data-automation-id="applyFlowPage"], [data-automation-id="pageFooterNextButton"], [data-automation-id="progressBar"], [data-automation-id="bottom-navigation-next-button"], input[data-automation-id="legalNameSection_firstName"]'))) {
    return { state: "wizard_ready", trace, url };
  }
  return null;
};

const navigation = await page.goto(applicationUrl, { waitUntil: "domcontentloaded", timeout: cap(15000) }).catch(() => undefined);
trace.push(navigation ? "navigation:loaded" : "navigation:unconfirmed");
if (strategy === "reload") {
  const reloaded = await page.reload({ waitUntil: "domcontentloaded", timeout: cap(15000) }).catch(() => undefined);
  trace.push(reloaded ? "navigation:reloaded" : "navigation:reload_unconfirmed");
}
// Workday is a single-page app: domcontentloaded fires long before any control
// exists, so routing against it finds an empty shell and gives up instantly.
const hydrated = await page.locator("[data-automation-id]").first()
  .waitFor({ state: "visible", timeout: cap(10000) }).then(() => true).catch(() => false);
trace.push(hydrated ? "hydration:ready" : "hydration:unconfirmed");

// Cookie banners are optional and never determine whether routing succeeded.
await click("cookie:accepted", page.getByRole("button", { name: /accept cookies|accept all/i })).catch(() => undefined);

let clicks = 0;
let iterations = 0;
let waited = false;
while (clicks < ${JSON.stringify(maxRouteClicks)} && iterations < ${JSON.stringify(maxRouteIterations)}) {
  iterations += 1;
  if (remaining() <= 2000) {
    trace.push("budget:exhausted");
    break;
  }
  const state = await currentState();
  if (state) return state;

  const root = await scopedRoot();
  let advanced = false;
  if (await inWallPhase()) {
    // Sign-in is preferred over create-account. Scope clicks to an open
    // dialog so a posting Apply behind the modal cannot intercept them.
    if (await click("email_route:automation_id", root.locator('button[data-automation-id="SignInWithEmailButton"]'))) advanced = true;
    else if (await click("email_route:button", root.getByRole("button", { name: /^sign in with email(?: address)?$/i }))) advanced = true;
    else if (await click("account_wall:sign_in_automation_id", root.locator('[data-automation-id="signInLink"]'))) advanced = true;
    else if (await click("account_wall:sign_in_link", root.getByRole("link", { name: /^sign in$/i }))) advanced = true;
    else if (await click("account_wall:sign_in_button", root.getByRole("button", { name: /^sign in$/i }))) advanced = true;
  } else {
    if (await click("continue_application:button", page.getByRole("button", { name: /^continue application$/i }))) advanced = true;
    else if (await click("continue_application:link", page.getByRole("link", { name: /^continue application$/i }))) advanced = true;
    else if (await click("apply_manually:automation_id", page.locator('[data-automation-id="applyManually"]'))) advanced = true;
    else if (await click("apply_manually:button", page.getByRole("button", { name: /^apply manually$/i }))) advanced = true;
    else if (await click("apply_manually:link", page.getByRole("link", { name: /^apply manually$/i }))) advanced = true;
    else if (await click("apply:adventure_button", page.locator('a[data-automation-id="adventureButton"], button[data-automation-id="adventureButton"]'))) advanced = true;
    else if (await click("apply:button", page.getByRole("button", { name: applyName }))) advanced = true;
    else if (await click("apply:link", page.getByRole("link", { name: applyName }))) advanced = true;
    else if (await click("sign_in:initial_button", page.getByRole("button", { name: /^sign in$/i }))) advanced = true;
    else if (await click("sign_in:initial_link", page.getByRole("link", { name: /^sign in$/i }))) advanced = true;
  }

  if (advanced) {
    clicks += 1;
    continue;
  }

  // Nothing matched. A slow tenant may still be rendering, so keep waiting
  // against the budget instead of giving up after a fixed number of loops.
  if (remaining() > 4000) {
    if (!waited) trace.push("await:rerender");
    waited = true;
    await page.waitForTimeout(1200);
    continue;
  }
  break;
}

const state = await currentState();
return state ?? { actions: await availableActions(), state: "route_incomplete", strategy, trace, url: page.url() };
`;
}

function workdayRouteUrl(
  applicationUrl: string,
  strategy: WorkdayRouteStrategy
) {
  if (strategy !== "autofill_path") return applicationUrl;
  const url = new URL(applicationUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/apply/autofillWithResume`;
  return url.toString();
}

export function workdayRestoreCode(applicationUrl: string) {
  return `await page.goto(${JSON.stringify(applicationUrl)}, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);`;
}

export function normalizeWorkdayRouteResult(
  response: PlaywrightExecuteResponse
): WorkdayRouteResult {
  // A timed-out or rejected execution is not evidence the site failed to load.
  // Collapsing the two hid real timeouts behind a navigation verdict and made
  // the caller abandon the strategies that would have recovered the route.
  if (!response.success) return { state: "execution_failed" };
  if (!isRouteResult(response.result)) return { state: "navigation_failed" };
  return response.result;
}

function isRouteResult(value: unknown): value is WorkdayRouteResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    actions?: unknown;
    attempt?: unknown;
    state?: unknown;
    strategy?: unknown;
    trace?: unknown;
    url?: unknown;
  };
  return (
    (candidate.state === "email_login_ready" ||
      candidate.state === "wizard_ready" ||
      candidate.state === "error_shell" ||
      candidate.state === "navigation_failed" ||
      candidate.state === "execution_failed" ||
      candidate.state === "route_incomplete") &&
    (candidate.actions === undefined ||
      (Array.isArray(candidate.actions) &&
        candidate.actions.every((entry) => typeof entry === "string"))) &&
    (candidate.attempt === undefined || Number.isInteger(candidate.attempt)) &&
    (candidate.strategy === undefined ||
      candidate.strategy === "direct" ||
      candidate.strategy === "reload" ||
      candidate.strategy === "autofill_path") &&
    (candidate.url === undefined || typeof candidate.url === "string") &&
    (candidate.trace === undefined ||
      (Array.isArray(candidate.trace) &&
        candidate.trace.every((entry) => typeof entry === "string")))
  );
}
