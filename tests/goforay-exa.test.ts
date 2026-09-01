import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const numResultsSchema = z.object({ numResults: z.number() });
const freshnessSchema = z.object({
  contents: z.object({ maxAgeHours: z.number() }),
  startPublishedDate: z.string(),
});

describe("role search availability", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("falls back to public discovery when the workspace has no JuiceBox candidate", async () => {
    vi.stubEnv("EXA_API_KEY", "exa-test-key");
    vi.doMock("@/db", () => ({}));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          results: [
            {
              text: "A remote strategic finance role.",
              title: "Strategic Finance Analyst | Example Co",
              url: "https://jobs.example.co/strategic-finance",
            },
          ],
        })
      )
    );

    const { findGoforayRoles } = await import("../lib/goforay/bridge");

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scope only reaches JuiceBox, which is unconfigured here.
    const scope = { kind: "user", userId: "better-auth:candidate" } as never;
    const feed = await findGoforayRoles(scope, {
      location: "Remote",
      query: "strategic finance analyst",
    });

    expect(feed.cards).toEqual([
      expect.objectContaining({
        title: "Strategic Finance Analyst",
        url: "https://jobs.example.co/strategic-finance",
      }),
    ]);
    expect(feed.searching).toBe(false);
    expect(feed.source).toBe("exa");
  });

  it("drops a public hit that is not a posting for the role asked for", async () => {
    // The reported incident: a private equity firm's homepage arrived as a
    // "strategic finance" card because every public hit became one.
    const feed = await publicSearch([
      {
        text: "Turn River Capital invests in software companies.",
        title: "Turn River | Software Growth Equity",
        url: "https://turnriver.com/",
      },
      {
        text: "You will own the annual plan and the three statement model.",
        title: "Senior Analyst, Strategic Finance | Example Co",
        url: "https://boards.greenhouse.io/example/jobs/4123456",
      },
    ]);

    expect(feed.cards).toEqual([
      expect.objectContaining({
        title: "Senior Analyst, Strategic Finance",
        url: "https://boards.greenhouse.io/example/jobs/4123456",
      }),
    ]);
  });

  it("over-fetches so the gate and the dedupe filter can still fill the batch", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ results: [] }));
    await publicSearch([], { fetch, limit: 5 });

    const init = fetch.mock.calls[0]?.[1];
    const body = exaRequestBody(init?.body);
    // Public search offers no offset and no exclusion, so a repeat search
    // returns the same top results; over-fetching is the only lever.
    expect(body.numResults).toBeGreaterThan(5);
  });

  it("drops a posting the page itself says is closed", async () => {
    // A closed Greenhouse posting keeps its URL and its title, so the shape
    // and title gate cannot see it. The body is the only signal left, and the
    // search response already carries one.
    const feed = await publicSearch([
      {
        text: "This role is no longer accepting applications. See our other openings.",
        title: "Senior Analyst, Strategic Finance | Example Co",
        url: "https://boards.greenhouse.io/example/jobs/4123456",
      },
      {
        text: "You will own the annual plan and the three statement model.",
        title: "Senior Analyst, Strategic Finance | Other Co",
        url: "https://boards.greenhouse.io/other/jobs/7654321",
      },
    ]);

    expect(feed.cards).toEqual([
      expect.objectContaining({
        url: "https://boards.greenhouse.io/other/jobs/7654321",
      }),
    ]);
  });

  it("asks Exa to re-crawl rather than serving a role from its cache", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ results: [] }));
    await publicSearch([], { fetch });

    const body = exaFreshness(fetch.mock.calls[0]?.[1]?.body);
    // Cached body text is why a role taken down last week still reads as open:
    // the closed-posting notice only exists on the live page.
    expect(body.contents.maxAgeHours).toBeGreaterThan(0);
    expect(Date.parse(body.startPublishedDate)).toBeLessThan(Date.now());
  });

  it("reports exhausted rather than resending a role already shown", async () => {
    const feed = await publicSearch(
      [
        {
          text: "You will own the annual plan.",
          title: "Senior Analyst, Strategic Finance | Example Co",
          url: "https://boards.greenhouse.io/example/jobs/4123456",
        },
      ],
      { presented: ["url:boards.greenhouse.io/example/jobs/4123456"] }
    );

    expect(feed.cards).toEqual([]);
    expect(feed.exhausted).toBe(true);
    expect(feed.unavailable).toBeUndefined();
  });

  it("flags a broken CRM link instead of passing web results off as curated", async () => {
    // The 07:11:54 production failure: a link row exists, and JuiceBox rejects
    // the token anyway. That is a broken link, not a missing one.
    const feed = await publicSearch(
      [
        {
          text: "You will own the annual plan.",
          title: "Senior Analyst, Strategic Finance | Example Co",
          url: "https://boards.greenhouse.io/example/jobs/4123456",
        },
      ],
      { link: { candidateId: "candidate-1", orgId: "org-1" } }
    );

    expect(feed.source).toBe("exa");
    expect(feed.cards).toHaveLength(1);
    expect(feed.degraded).toEqual({
      from: "juicebox",
      reason: "link_broken",
      detail: "OpenInstinct account is not linked",
    });
  });

  it("stays quiet for a candidate who never linked, which is the normal path", async () => {
    const feed = await publicSearch([
      {
        text: "You will own the annual plan.",
        title: "Senior Analyst, Strategic Finance | Example Co",
        url: "https://boards.greenhouse.io/example/jobs/4123456",
      },
    ]);

    expect(feed.source).toBe("exa");
    expect(feed.degraded).toBeUndefined();
  });
});

/** The URL a stubbed fetch was called with, without stringifying a Request. */
function calledUrl(input: unknown) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return "";
}

/** The freshness parameters a stubbed Exa call asked for. */
function exaFreshness(body: unknown) {
  const parsed: unknown = JSON.parse(typeof body === "string" ? body : "{}");
  return freshnessSchema.parse(parsed);
}

/** The `numResults` a stubbed Exa call asked for. */
function exaRequestBody(body: unknown) {
  const parsed: unknown = JSON.parse(typeof body === "string" ? body : "{}");
  return numResultsSchema.parse(parsed);
}

/**
 * Runs a search with JuiceBox reachable only if `link` is supplied, in which
 * case its job feed rejects the way production did.
 */
async function publicSearch(
  results: { text: string; title: string; url: string }[],
  {
    fetch: fetchMock,
    limit,
    link,
    presented = [],
  }: {
    fetch?: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
    limit?: number;
    link?: { candidateId: string; orgId: string };
    presented?: string[];
  } = {}
) {
  vi.stubEnv("EXA_API_KEY", "exa-test-key");
  vi.stubEnv("JUICEBOX_API_URL", "https://api.example.test");
  vi.stubEnv("OPENINSTINCT_SHARED_SECRET", "s".repeat(32));

  const rows = presented.map((roleKey) => ({ postingId: "", roleKey }));
  vi.doMock("@/db/services/goforay-presented-roles", () => ({
    listPresentedRoles: () =>
      Promise.resolve({
        keys: new Set(rows.map((row) => row.roleKey)),
        postingIds: [],
      }),
    rememberPresentedRoles: () => Promise.resolve(),
  }));
  // `@/db` builds a connection pool on import, so stub the client but keep the
  // real table definitions the bridge's `where` clauses are built from.
  vi.doMock("@/db", async () => ({
    ...(await import("@/db/schema")),
    db: {
      query: {
        goforayWorkspaceLinks: { findFirst: () => Promise.resolve(link) },
      },
    },
  }));

  const fetch =
    fetchMock ??
    vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes("api.example.test")) {
        return Promise.resolve(
          Response.json(
            { detail: "OpenInstinct account is not linked" },
            { status: 403 }
          )
        );
      }
      return Promise.resolve(Response.json({ results }));
    });
  vi.stubGlobal("fetch", fetch);

  const { findGoforayRoles } = await import("../lib/goforay/bridge");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the ids are read.
  const scope = {
    userId: "phone:digest",
    workspaceId: "phone:digest",
  } as never;
  return findGoforayRoles(scope, {
    limit: limit ?? 5,
    location: "Remote",
    query: "senior strategic finance",
    role: "strategic finance",
    seniority: "senior",
  });
}
