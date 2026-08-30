import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("web search routing", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("searches Exa with the configured key and drops duplicate URLs", async () => {
    vi.stubEnv("EXA_API_KEY", "exa-test-key");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Strategic Finance Analyst | Example Co",
            url: "https://jobs.example.co/strategic-finance",
            text: "Entry  level\n strategic finance opening.",
          },
          {
            title: "Same posting",
            url: "https://JOBS.example.co/strategic-finance",
            text: "Duplicate.",
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetch);

    const { compactText, exaSearch } = await import("../lib/exa");
    const results = await exaSearch({
      query: "entry level strategic finance jobs",
      limit: 5,
    });

    expect(results).toEqual([
      expect.objectContaining({
        title: "Strategic Finance Analyst | Example Co",
        url: "https://jobs.example.co/strategic-finance",
      }),
    ]);
    expect(compactText(results[0]?.text ?? "", 600)).toBe(
      "Entry level strategic finance opening."
    );

    const [url, init] = fetch.mock.calls[0] ?? [];
    const body = typeof init?.body === "string" ? init.body : "";
    expect(url).toBe("https://api.exa.ai/search");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("exa-test-key");
    expect(body).toContain('"query":"entry level strategic finance jobs"');
    expect(body).toContain('"numResults":5');
  });

  it("fails with an actionable message when Exa is not configured", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    const { exaSearch } = await import("../lib/exa");
    await expect(exaSearch({ query: "anything", limit: 3 })).rejects.toThrow(
      "Exa search is not configured."
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exposes web_search as a root tool backed by Exa", () => {
    const tool = readFileSync("agent/tools/web_search.ts", "utf8");

    expect(tool).toContain('from "@/lib/exa"');
    expect(tool).toContain("defineTool(");
    expect(tool).toContain("exaSearch(");
    expect(tool).toContain("context.abortSignal");
  });

  it("routes search-shaped requests to the tool instead of claiming no search", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");

    expect(instructions).toContain("`web_search`");
    expect(instructions).toContain("no built-in web browsing");
    expect(instructions).toContain("Never tell the");
    expect(instructions).toContain("When `source` is `exa`, the channel sends");
  });
});
