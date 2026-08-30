import { afterEach, describe, expect, it, vi } from "vitest";

describe("Exa role discovery", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns deduplicated public job leads with their source URLs", async () => {
    vi.stubEnv("EXA_API_KEY", "exa-test-key");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Senior Platform Engineer | Example Co",
            url: "https://jobs.example.co/platform-engineer",
            text: "Remote platform role building reliable data infrastructure.",
          },
          {
            title: "Duplicate",
            url: "https://jobs.example.co/platform-engineer",
            text: "Same listing.",
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetch);

    const { searchExaRoles } = await import("../lib/goforay/exa");
    const roles = await searchExaRoles({
      query: "platform engineer",
      location: "Remote",
      limit: 5,
    });

    expect(roles).toEqual([
      expect.objectContaining({
        company: "example",
        location: "Remote",
        title: "Senior Platform Engineer",
        url: "https://jobs.example.co/platform-engineer",
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({ method: "POST" })
    );
  });
});
