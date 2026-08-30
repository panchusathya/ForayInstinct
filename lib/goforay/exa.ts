import { compactText, exaSearch } from "@/lib/exa";
import type { GoForayJobCard } from "./job-cards";

const atsHostPattern =
  /(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|jobvite\.com|workable\.com|taleo\.net|successfactors|bamboohr\.com|applytojob\.com|linkedin\.com|indeed\.com|wellfound\.com)/iu;
const postingPathPattern =
  /\/(?:job|jobs|career|careers|opening|openings|position|positions|requisition)s?\//iu;
const listingRootPattern = /^\/(?:careers|jobs|job|search)?$/iu;

function roleTitle(value: string) {
  const first = value.split(/[|—–-]/u, 1)[0]?.trim() ?? "";
  return first || "Open role";
}

function companyFromUrl(value: string) {
  const hostname = new URL(value).hostname.replace(/^www\./u, "");
  const parts = hostname.split(".");
  if (parts.length < 2) return hostname;
  return parts.at(-2) ?? hostname;
}

function pathSegments(pathname: string) {
  return pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
}

/** True for a posting page, false for a careers homepage or company root. */
export function isLikelyJobPostingUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    const segments = pathSegments(url.pathname);
    if (path === "/" || listingRootPattern.test(path)) return false;
    if (atsHostPattern.test(host) && segments.length >= 1) return true;
    if (postingPathPattern.test(`${path}/`) && segments.length >= 2) return true;
    if (/^jobs\./iu.test(host) && segments.length >= 1) return true;
    return false;
  } catch {
    return false;
  }
}

function isNotBareListingPage(value: string) {
  try {
    const path = new URL(value).pathname.replace(/\/+$/u, "") || "/";
    return path !== "/" && !listingRootPattern.test(path);
  } catch {
    return false;
  }
}

function toRoleCard(
  result: { text: string; title: string; url: string },
  location?: string
): GoForayJobCard {
  return {
    company: companyFromUrl(result.url),
    location: location?.trim() || "See posting",
    reasons: result.text
      ? [compactText(result.text, 280)]
      : ["Found through public job search."],
    title: roleTitle(result.title),
    url: result.url,
  };
}

/**
 * Best-effort public discovery for candidates with no current CRM matches.
 * Exa returns source URLs; Foray never invents an employer or an apply link.
 * Careers homepages are dropped so the coordinator always gets a posting URL.
 */
export async function searchExaRoles({
  query,
  location,
  limit,
}: {
  query?: string;
  location?: string;
  limit: number;
}): Promise<GoForayJobCard[]> {
  const focus = query?.trim() || "current open professional roles";
  const where = location?.trim() ? ` in ${location.trim()}` : "";
  const results = await exaSearch({
    query: `${focus}${where} current job posting apply now`,
    limit: Math.min(Math.max(limit * 2, limit), 10),
  });

  const postings = results.filter((result) => isLikelyJobPostingUrl(result.url));
  const fallback = results.filter((result) => isNotBareListingPage(result.url));
  const picked = (postings.length ? postings : fallback).slice(0, limit);

  return picked.map((result) => toRoleCard(result, location));
}
