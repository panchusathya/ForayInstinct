import type { PlaywrightExecuteResponse } from "@onkernel/sdk/resources/browsers";

export type WorkdayRouteState =
  | "email_login_ready"
  | "wizard_ready"
  | "error_shell"
  | "navigation_failed"
  | "route_incomplete";

export interface WorkdayRouteResult {
  actions?: string[];
  state: WorkdayRouteState;
  trace?: string[];
  url?: string;
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

export function workdayRouterCode(applicationUrl: string): string {
  return `
const applicationUrl = ${JSON.stringify(applicationUrl)};
const trace = [];
const availableActions = async () => page.locator("a, button").evaluateAll((nodes) => nodes
  .map((node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
  .filter((label) => /apply|continue|sign in|create account/i.test(label))
  .slice(0, 12)
).catch(() => []);
const visible = async (locator) => locator.first().isVisible().catch(() => false);
const click = async (step, locator) => {
  if (!(await visible(locator))) return false;
  await locator.first().click({ timeout: 5000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
  trace.push(step);
  return true;
};
const currentState = async () => {
  const url = page.url();
  if (url.startsWith("chrome-error://")) return { state: "navigation_failed", trace, url };
  const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (/something went wrong|unexpected error|we're sorry|try again later/i.test(body)) {
    return { state: "error_shell", trace, url };
  }
  if (await visible(page.locator('input[type="password"], input[data-automation-id="password"]'))) {
    return { state: "email_login_ready", trace, url };
  }
  if (await visible(page.locator('[data-automation-id="applyFlowPage"], [data-automation-id="pageFooterNextButton"], [data-automation-id="progressBar"], [data-automation-id="bottom-navigation-next-button"], input[data-automation-id="legalNameSection_firstName"]'))) {
    return { state: "wizard_ready", trace, url };
  }
  return null;
};

const navigation = await page.goto(applicationUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
trace.push(navigation ? "navigation:loaded" : "navigation:unconfirmed");
await page.locator("body").waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);

// Cookie banners are optional and never determine whether routing succeeded.
await click("cookie:accepted", page.getByRole("button", { name: /accept cookies|accept all/i })).catch(() => undefined);

for (let attempt = 0; attempt < 4; attempt += 1) {
  const state = await currentState();
  if (state) return state;

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
  break;
}

const state = await currentState();
return state ?? { actions: await availableActions(), state: "route_incomplete", trace, url: page.url() };
`;
}

export function normalizeWorkdayRouteResult(
  response: PlaywrightExecuteResponse
): WorkdayRouteResult {
  if (!response.success || !isRouteResult(response.result)) {
    return { state: "navigation_failed" };
  }
  return response.result;
}

function isRouteResult(value: unknown): value is WorkdayRouteResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    actions?: unknown;
    state?: unknown;
    trace?: unknown;
    url?: unknown;
  };
  return (
    (candidate.state === "email_login_ready" ||
      candidate.state === "wizard_ready" ||
      candidate.state === "error_shell" ||
      candidate.state === "navigation_failed" ||
      candidate.state === "route_incomplete") &&
    (candidate.actions === undefined ||
      (Array.isArray(candidate.actions) &&
        candidate.actions.every((entry) => typeof entry === "string"))) &&
    (candidate.url === undefined || typeof candidate.url === "string") &&
    (candidate.trace === undefined ||
      (Array.isArray(candidate.trace) &&
        candidate.trace.every((entry) => typeof entry === "string")))
  );
}
