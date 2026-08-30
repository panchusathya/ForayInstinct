import { z } from "zod";
import { env } from "@/lib/env";

/**
 * Shared Exa client. The chat model has no built-in web search, so every
 * request that needs live public information goes through Exa instead of the
 * model pretending to browse (or the provider returning an upstream error for
 * a search capability the model does not have).
 */

const exaResultSchema = z.object({
  author: z.string().nullish(),
  publishedDate: z.string().nullish(),
  text: z.string().catch(""),
  title: z.string().catch(""),
  url: z.url(),
});

const exaResponseSchema = z.object({ results: z.array(exaResultSchema) });

type ExaResult = z.infer<typeof exaResultSchema>;

/** Collapses whitespace and trims a snippet to a model-friendly length. */
export function compactText(value: string, maximum: number) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

/** First result per URL, in Exa's own relevance order. */
function dedupeByUrl(results: ExaResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function exaSearch({
  query,
  limit,
  category,
  maxCharacters = 1_500,
  signal,
}: {
  query: string;
  limit: number;
  category?: "company" | "news" | "papers" | "pdf";
  maxCharacters?: number;
  signal?: AbortSignal;
}): Promise<ExaResult[]> {
  if (!env.EXA_API_KEY) throw new Error("Exa search is not configured.");

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: limit,
      ...(category ? { category } : {}),
      contents: { text: { maxCharacters } },
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Exa search failed (${String(response.status)}).`);

  const payload = exaResponseSchema.parse(await response.json());
  return dedupeByUrl(payload.results).slice(0, limit);
}
