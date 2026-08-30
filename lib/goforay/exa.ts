import { compactText, exaSearch } from "@/lib/exa";

export type ExaRoleCard = {
  company: string;
  location: string;
  reasons: string[];
  title: string;
  url: string;
};

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

/**
 * Best-effort public discovery for candidates with no current CRM matches.
 * Exa returns source URLs; Foray never invents an employer or an apply link.
 */
export async function searchExaRoles({
  query,
  location,
  limit,
}: {
  query?: string;
  location?: string;
  limit: number;
}): Promise<ExaRoleCard[]> {
  const focus = query?.trim() || "current open professional roles";
  const where = location?.trim() ? ` in ${location.trim()}` : "";
  const results = await exaSearch({
    query: `${focus}${where} jobs careers apply`,
    limit,
  });

  return results.map((result) => ({
    company: companyFromUrl(result.url),
    location: location?.trim() || "See posting",
    reasons: result.text
      ? [compactText(result.text, 280)]
      : ["Found through public job search."],
    title: roleTitle(result.title),
    url: result.url,
  }));
}
