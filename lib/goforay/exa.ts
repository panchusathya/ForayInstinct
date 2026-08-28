import { z } from "zod";
import { env } from "@/lib/env";

const exaResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().catch(""),
      url: z.string().url(),
      text: z.string().catch(""),
    })
  ),
});

export type ExaRoleCard = {
  company: string;
  location: string;
  reasons: string[];
  title: string;
  url: string;
};

function compact(value: string, maximum: number) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

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
  if (!env.EXA_API_KEY) {
    throw new Error("Exa role discovery is not configured.");
  }

  const focus = query?.trim() || "current open professional roles";
  const where = location?.trim() ? ` in ${location.trim()}` : "";
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query: `${focus}${where} jobs careers apply`,
      type: "auto",
      numResults: limit,
      contents: { text: { maxCharacters: 1_500 } },
    }),
  });
  if (!response.ok) {
    throw new Error(`Exa role discovery failed (${response.status}).`);
  }

  const payload = exaResponseSchema.parse(await response.json());
  const seen = new Set<string>();
  return payload.results
    .filter((result) => {
      const key = result.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((result) => ({
      company: companyFromUrl(result.url),
      location: location?.trim() || "See posting",
      reasons: result.text ? [compact(result.text, 280)] : ["Found through public job search."],
      title: roleTitle(result.title),
      url: result.url,
    }));
}
