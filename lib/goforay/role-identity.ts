import { sanitizeHostname } from "./card-logo";
import type { GoForayJobCard } from "./job-cards";

/**
 * A source-agnostic identity for a role, so "show me more" can exclude what a
 * candidate has already seen. JuiceBox cards carry a posting id; public cards
 * only ever have their apply URL, which is why the presented-roles store keys
 * on this rather than on `posting_id`.
 */

/**
 * Params that identify which posting a URL points at. Everything else is
 * campaign noise. Kept as a denylist on purpose: `?gh_jid=1` and `?gh_jid=2`
 * are two different jobs on one Greenhouse path, so an allowlist that dropped
 * unrecognised params would collapse them and hide a real role.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gh_src",
  "lever-origin",
  "lever-source",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "referrer",
  "refid",
  "source",
  "src",
  "trackingid",
  "trk",
]);

function isTrackingParam(name: string) {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/**
 * Collapses the same posting reached by different links to one string. Path
 * case is preserved: Workday and iCIMS posting ids are case-sensitive.
 */
export function normalizeJobUrl(raw: string) {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  const host = sanitizeHostname(parsed.hostname);
  if (!host) return trimmed.toLowerCase();

  const path = parsed.pathname.replace(/\/+$/u, "");
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name.toLowerCase()}=${value}`);

  return `${host}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

/** A posting id wins, so one posting behind two URLs is still one role. */
export function roleKey(card: Pick<GoForayJobCard, "posting_id" | "url">) {
  const postingId = card.posting_id?.trim();
  if (postingId) return `posting:${postingId}`;
  return `url:${normalizeJobUrl(card.url)}`;
}
