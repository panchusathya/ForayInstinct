import { defineTool } from "eve/tools";
import { z } from "zod";
import { compactText, exaSearch } from "@/lib/exa";

/**
 * The chat model has no native web search. Without this tool a search request
 * either invented an answer or failed upstream as an unsupported capability,
 * so every live-web lookup routes through Exa here instead.
 */
export default defineTool({
  description:
    "Search the live web through Exa. You have no built-in browsing and no knowledge of anything current, so call this for any question that depends on public information you cannot already answer from this conversation: open roles at a company, news, prices, people, products, documentation, company research, or checking whether a page says what the user thinks. This is not the route to a role or an application: anything about the candidate's own openings, roles, or applying goes to `find_goforay_roles`, however the request is worded, because results here carry no posting id. Never tell the user you cannot search. Summarize the results in plain prose with the source links; never paste this object.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(400)
      .describe("A specific natural-language search query."),
    category: z
      .enum(["company", "news", "papers", "pdf"])
      .optional()
      .describe(
        "Narrow the search to one kind of source when it clearly fits."
      ),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async execute({ query, category, limit }, context) {
    const results = await exaSearch({
      query,
      category,
      limit,
      signal: context.abortSignal,
    });
    return {
      query,
      results: results.map((result) => ({
        published: result.publishedDate ?? undefined,
        snippet: compactText(result.text, 600),
        title: result.title || result.url,
        url: result.url,
      })),
    };
  },
});
