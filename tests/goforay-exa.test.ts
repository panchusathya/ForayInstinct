import { afterEach, describe, expect, it, vi } from "vitest";

describe("Exa role discovery", () => {
  afterEach(() => {
    vi.resetModules();
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
    const [, init] = fetch.mock.calls[0] ?? [];
    const body = typeof init?.body === "string" ? init.body : "";
    expect(fetch).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({ method: "POST" })
    );
    expect(body).toContain("current job posting apply now");
  });

  it("drops careers homepages in favor of posting URLs", async () => {
    vi.stubEnv("EXA_API_KEY", "exa-test-key");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Careers | The Toro Company",
            url: "https://www.toro.com/careers",
            text: "Search jobs at Toro.",
          },
          {
            title: "Sr. Analyst, Corporate Development | The Toro Company",
            url: "https://jobs.thetorocompany.com/job/bloomington/corp-dev/1",
            text: "Support M&A processes and financial models.",
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetch);

    const { searchExaRoles } = await import("../lib/goforay/exa");
    const roles = await searchExaRoles({
      query: "corporate development",
      location: "Remote",
      limit: 5,
    });

    expect(roles).toEqual([
      expect.objectContaining({
        title: "Sr. Analyst, Corporate Development",
        url: "https://jobs.thetorocompany.com/job/bloomington/corp-dev/1",
      }),
    ]);
  });

  it("recognizes posting URLs and rejects listing homepages", async () => {
    const { isLikelyJobPostingUrl } = await import("../lib/goforay/exa");

    expect(
      isLikelyJobPostingUrl(
        "https://jobs.thetorocompany.com/job/bloomington/financial-analyst/1"
      )
    ).toBe(true);
    expect(
      isLikelyJobPostingUrl(
        "https://boards.greenhouse.io/acme/jobs/123"
      )
    ).toBe(true);
    expect(isLikelyJobPostingUrl("https://www.toro.com/careers")).toBe(false);
    expect(isLikelyJobPostingUrl("https://www.toro.com/")).toBe(false);
  });
});

describe("role search availability", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("reports search as unavailable instead of throwing at the model", async () => {
    vi.stubEnv("EXA_API_KEY", "");
    vi.doMock("@/db", () => ({}));

    const { findGoforayRoles } = await import("../lib/goforay/bridge");

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scope only reaches JuiceBox, which is unconfigured here.
    const scope = { kind: "user", userId: "better-auth:candidate" } as never;
    const feed = await findGoforayRoles(scope);

    expect(feed.cards).toEqual([]);
    expect(feed.unavailable).toBe("Exa search is not configured.");
  });
});
