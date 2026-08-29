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
 * The router script must finish inside its own budget and return a structured
 * state. Kernel killing the execution instead yields no trace at all, which is
 * why the in-script deadline is shorter than the request timeout.
 */
const routeBudgetMs = 55_000;
export const workdayRouteTimeoutSec = 75;

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
const trace = [];
const tried = new Set();
const availableActions = async () => page.locator("a, button").evaluateAll((nodes) => nodes
  .map((node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
  .filter((label) => /apply|continue|sign in|create account/i.test(label))
  .slice(0, 12)
).catch(() => []);
const visible = async (locator) => locator.first().isVisible().catch(() => false);
const click = async (step, locator) => {
  // A control that did not advance the page stays clicked; re-clicking it only
  // burned the attempt budget and left the router reporting no progress.
  if (tried.has(step)) return false;
  if (!(await visible(locator))) return false;
  tried.add(step);
  const clicked = await locator.first().click({ timeout: cap(5000) }).then(() => true).catch(() => false);
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded", { timeout: cap(3000) }).catch(() => undefined);
  trace.push(step);
  return true;
};
const signupOnly = async () => visible(page.locator('input[data-automation-id="verifyPassword"], input[data-automation-id="verifyNewPassword"]'));
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

let waited = false;
for (let attempt = 0; attempt < 6; attempt += 1) {
  if (remaining() <= 2000) {
    trace.push("budget:exhausted");
    break;
  }
  const state = await currentState();
  if (state) return state;

  // The account wall can open on Create Account; switch it to the sign-in panel
  // rather than reporting a form the vault must not fill.
  if (await signupOnly()) {
    if (await click("account_wall:sign_in_automation_id", page.locator('[data-automation-id="signInLink"]'))) continue;
    if (await click("account_wall:sign_in_link", page.getByRole("link", { name: /^sign in$/i }))) continue;
    if (await click("account_wall:sign_in_button", page.getByRole("button", { name: /^sign in$/i }))) continue;
  }

  // This exact route avoids the unrelated global/header Sign In control.
  if (await click("continue_application:button", page.getByRole("button", { name: /^continue application$/i }))) continue;
  if (await click("continue_application:link", page.getByRole("link", { name: /^continue application$/i }))) continue;
  if (await click("apply_manually:automation_id", page.locator('[data-automation-id="applyManually"]'))) continue;
  if (await click("apply_manually:button", page.getByRole("button", { name: /^apply manually$/i }))) continue;
  if (await click("apply_manually:link", page.getByRole("link", { name: /^apply manually$/i }))) continue;
  if (await click("email_route:automation_id", page.locator('button[data-automation-id="SignInWithEmailButton"]'))) continue;
  if (await click("email_route:button", page.getByRole("button", { name: /^sign in with email(?: address)?$/i }))) continue;
  if (await click("apply:adventure_button", page.locator('a[data-automation-id="adventureButton"], button[data-automation-id="adventureButton"]'))) continue;
  if (await click("apply:button", page.getByRole("button", { name: /^apply$/i }))) continue;
  if (await click("apply:link", page.getByRole("link", { name: /^apply$/i }))) continue;
  // Intapp sometimes exposes only this initial account entry point on a job page.
  // This fallback runs after every concrete application control has been checked.
  if (await click("sign_in:initial_button", page.getByRole("button", { name: /^sign in$/i }))) continue;
  if (await click("sign_in:initial_link", page.getByRole("link", { name: /^sign in$/i }))) continue;

  // Nothing matched. A slow tenant may still be rendering, so give the app one
  // bounded chance to paint before declaring the route incomplete.
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
