import { exaSearch } from "@/lib/exa";
import { employerDomainFromUrl, sanitizeHostname } from "./card-logo";
import { TITLE_COMPANY_SEPARATORS, type GoForayJobCard } from "./job-cards";
import {
  locationFromResult,
  reasonsForCandidate,
  scoreRoleCandidate,
} from "./relevance";

const GENERIC_TITLE_PART_RE = /^(?:careers?|jobs?|home|open roles)$/iu;

const DAY_MS = 24 * 60 * 60 * 1_000;
/**
 * Force a re-crawl of anything Exa last saw more than a day ago. Cached body
 * text is the reason a role taken down last week still reads as open: the
 * closed-posting notice an ATS leaves behind is only in the live page.
 */
const ROLE_MAX_AGE_HOURS = 24;
/** Older postings are rarely still open, and rarely still worth a candidate's turn. */
const ROLE_PUBLISHED_WITHIN_DAYS = 180;
/**
 * Immediacy is the product. A re-crawl costs real latency, so cap it and fall
 * back to Exa's cache rather than letting a slow crawl hold up the search.
 */
const FRESH_CRAWL_TIMEOUT_MS = 12_000;

/**
 * Freshest results this search can afford, degrading rather than failing.
 * Each fallback gives up one guarantee: first the live crawl, then the
 * publication window, which plenty of ATS pages carry no date for at all.
 */
async function searchRoleCandidates(query: string, limit: number) {
  const startPublishedDate = new Date(
    Date.now() - ROLE_PUBLISHED_WITHIN_DAYS * DAY_MS
  ).toISOString();

  const fresh = await exaSearch({
    query,
    limit,
    maxAgeHours: ROLE_MAX_AGE_HOURS,
    startPublishedDate,
    signal: AbortSignal.timeout(FRESH_CRAWL_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.info("[goforay] role crawl fell back to cached results", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  });

  const dated =
    fresh ?? (await exaSearch({ query, limit, startPublishedDate }));
  // An empty window is a filter artefact, not an empty market.
  return dated.length ? dated : await exaSearch({ query, limit });
}

/**
 * Splits a page title into the role and the company. Only the spaced
 * separators count: splitting on a bare hyphen turned "Senior Manager -
 * Strategic Finance" into "Senior Manager", which the relevance gate then
 * rejected as a role it had actually been asked for.
 */
function splitTitle(value: string) {
  const title = value.replace(/\s+/gu, " ").trim();
  for (const separator of TITLE_COMPANY_SEPARATORS) {
    const at = title.indexOf(separator);
    if (at === -1) continue;
    const head = title.slice(0, at).trim();
    const tail = title.slice(at + separator.length).trim();
    if (!head || !tail) continue;
    // "Careers | Senior Analyst, FP&A" puts the role second.
    return GENERIC_TITLE_PART_RE.test(head)
      ? { role: tail, company: "" }
      : { role: head, company: tail };
  }
  return { role: title, company: "" };
}

function hostLabel(url: string) {
  const host = sanitizeHostname(url);
  if (!host) return "";
  const parts = host.split(".");
  return (parts.length < 2 ? host : parts.at(-2)) ?? "";
}

/**
 * The employer, preferring the company the page names itself. The host label
 * alone produced "turnriver" for a firm's homepage, and "boards" or "jobs" for
 * any Greenhouse or Lever posting.
 */
function companyFor(url: string, titleCompany: string) {
  if (titleCompany && !GENERIC_TITLE_PART_RE.test(titleCompany))
    return titleCompany;
  // Empty for an ATS host, which is itself the signal that the hostname is the
  // vendor rather than the employer.
  const employer = employerDomainFromUrl(url);
  if (employer) {
    const label = hostLabel(employer);
    if (label) return label;
  }
  return hostLabel(url) || "Employer";
}

/**
 * Public job discovery for people without a CRM candidate association.
 *
 * `wanted` is the relevance contract: hits that are not a single posting for
 * the role asked for are dropped rather than surfaced as cards, so callers
 * should over-fetch to still fill their limit.
 */
export async function searchExaRoles({
  query,
  location,
  limit,
  wanted = [],
}: {
  query: string;
  location: string;
  limit: number;
  wanted?: readonly string[];
}): Promise<GoForayJobCard[]> {
  const results = await searchRoleCandidates(
    `${query} jobs careers apply in ${location}`,
    limit
  );

  const cards: GoForayJobCard[] = [];
  for (const result of results) {
    const { role, company } = splitTitle(result.title);
    const relevance = scoreRoleCandidate({
      title: role,
      url: result.url,
      text: result.text,
      wanted,
    });
    if (relevance.verdict === "reject") {
      console.info("[goforay] dropped a public role hit", {
        reason: relevance.reason,
        url: result.url,
      });
      continue;
    }
    cards.push({
      company: companyFor(result.url, company),
      location: locationFromResult(result.title, result.text),
      reasons: reasonsForCandidate({
        matched: relevance.matched,
        text: result.text,
        wanted,
      }),
      source_label: "open market",
      title: role || "Open role",
      url: result.url,
    });
  }
  return cards;
}
