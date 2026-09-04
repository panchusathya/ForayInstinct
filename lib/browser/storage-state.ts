import type { GatewayStorageState } from "@/lib/browser/contract";

/**
 * Drops the cookies a fresh Chromium context will refuse to take.
 *
 * `Storage.setCookies` rejects the whole batch when any one cookie is
 * excluded, and Playwright reports it as "Overriding ... cookies is
 * forbidden"; the gateway then fails to create the session at all, and every
 * application for that workspace dies on the same stored blob until it is
 * cleared. The exclusions this can see coming: a cookie that has already
 * expired, a SameSite=None cookie without Secure, a `__Secure-`/`__Host-`
 * cookie without Secure, and the same cookie exported twice for one domain and
 * path, where the two copies disagree. Anything else is left exactly as
 * exported.
 */
export function sanitizeStorageState(
  state: GatewayStorageState,
  now = Date.now()
): GatewayStorageState {
  const kept = new Map<string, Record<string, unknown>>();
  for (const cookie of state.cookies) {
    const name = typeof cookie.name === "string" ? cookie.name : "";
    if (name === "") continue;
    const expires = typeof cookie.expires === "number" ? cookie.expires : -1;
    if (expires > 0 && expires * 1000 < now) continue;
    const secure = cookie.secure === true;
    if (cookie.sameSite === "None" && !secure) continue;
    if (/^__(?:secure|host)-/iu.test(name) && !secure) continue;
    const domain = typeof cookie.domain === "string" ? cookie.domain : "";
    const path = typeof cookie.path === "string" ? cookie.path : "/";
    // Last one wins, matching how a later Set-Cookie replaces an earlier one.
    kept.set(`${name} ${domain} ${path}`, cookie);
  }
  return { cookies: [...kept.values()], origins: state.origins };
}

/** Whether a session failed while seeding cookies, rather than anywhere else. */
export function isCookieSeedFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /addCookies|setCookies|cookies? is forbidden/iu.test(message);
}
