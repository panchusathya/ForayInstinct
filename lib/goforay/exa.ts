import { exaSearch } from "@/lib/exa";
import { employerDomainFromUrl, sanitizeHostname } from "./card-logo";
import { TITLE_COMPANY_SEPARATORS, type GoForayJobCard } from "./job-cards";
import {
  locationFromResult,
  reasonsForCandidate,
  scoreRoleCandidate,
} from "./relevance";

const GENERIC_TITLE_PART_RE = /^(?:careers?|jobs?|home|open roles)$/iu;

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
  const results = await exaSearch({
    query: `${query} jobs careers apply in ${location}`,
    limit,
  });

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
