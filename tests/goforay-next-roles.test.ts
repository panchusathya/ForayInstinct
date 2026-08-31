import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `find_next_goforay_roles` was the only deduping path and the only one that
 * threw. When the CRM rejected the link it surfaced to the model as a failed
 * tool, and the model answered "find me more strategic finance jobs" with a
 * generic web search — which is how a private equity firm reached a candidate.
 */
describe("next goforay roles", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("degrades to public discovery instead of throwing when the link is rejected", async () => {
    const { nextGoforayRoles } = await load({
      link: { candidateId: "candidate-1", orgId: "org-1" },
    });

    const feed = await nextGoforayRoles(scope(), {
      location: "Remote",
      query: "senior strategic finance",
      role: "strategic finance",
    });

    expect(feed.source).toBe("exa");
    expect(feed.cards).toHaveLength(1);
    expect(feed.degraded?.reason).toBe("link_broken");
  });

  it("searches the criteria in play rather than an empty query", async () => {
    const { nextGoforayRoles, fetch } = await load({
      link: { candidateId: "candidate-1", orgId: "org-1" },
    });

    await nextGoforayRoles(scope(), {
      location: "Remote",
      query: "senior strategic finance",
      role: "strategic finance",
    });

    const feedCall = fetch.mock.calls.find((call) =>
      calledUrl(call[0]).includes("/job-feed")
    );
    const url = new URL(calledUrl(feedCall?.[0]));
    expect(url.searchParams.get("q")).toBe("senior strategic finance");
    expect(url.searchParams.get("location")).toBe("Remote");
  });

  it("excludes postings the workspace has already been shown", async () => {
    const { nextGoforayRoles, fetch } = await load({
      link: { candidateId: "candidate-1", orgId: "org-1" },
      postingIds: ["posting-1", "posting-2"],
    });

    await nextGoforayRoles(scope(), { query: "strategic finance" });

    const feedCall = fetch.mock.calls.find((call) =>
      calledUrl(call[0]).includes("/job-feed")
    );
    const url = new URL(calledUrl(feedCall?.[0]));
    expect(url.searchParams.getAll("exclude_posting_id")).toEqual([
      "posting-1",
      "posting-2",
    ]);
  });

  it("never asks the feed for more than five roles at a time", async () => {
    const { nextGoforayRoles, fetch } = await load({
      link: { candidateId: "candidate-1", orgId: "org-1" },
    });

    await nextGoforayRoles(scope(), { limit: 10, query: "strategic finance" });

    const feedCall = fetch.mock.calls.find((call) =>
      calledUrl(call[0]).includes("/job-feed")
    );
    expect(new URL(calledUrl(feedCall?.[0])).searchParams.get("limit")).toBe(
      "5"
    );
  });
});

/** The URL a stubbed fetch was called with, without stringifying a Request. */
function calledUrl(input: unknown) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return "";
}

function scope() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the ids are read.
  return { userId: "phone:digest", workspaceId: "phone:digest" } as never;
}

async function load({
  link,
  postingIds = [],
}: {
  link?: { candidateId: string; orgId: string };
  postingIds?: string[];
}) {
  vi.stubEnv("EXA_API_KEY", "exa-test-key");
  vi.stubEnv("JUICEBOX_API_URL", "https://api.example.test");
  vi.stubEnv("OPENINSTINCT_SHARED_SECRET", "s".repeat(32));

  vi.doMock("@/db/services/goforay-presented-roles", () => ({
    listPresentedRoles: () =>
      Promise.resolve({ keys: new Set<string>(), postingIds }),
    rememberPresentedRoles: () => Promise.resolve(),
  }));
  vi.doMock("@/db", async () => ({
    ...(await import("@/db/schema")),
    db: {
      query: {
        goforayWorkspaceLinks: { findFirst: () => Promise.resolve(link) },
      },
    },
  }));

  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes("api.example.test")) {
      return Promise.resolve(
        Response.json(
          { detail: "OpenInstinct account is not linked" },
          { status: 403 }
        )
      );
    }
    return Promise.resolve(
      Response.json({
        results: [
          {
            text: "You will own the annual plan.",
            title: "Senior Analyst, Strategic Finance | Example Co",
            url: "https://boards.greenhouse.io/example/jobs/4123456",
          },
        ],
      })
    );
  });
  vi.stubGlobal("fetch", fetch);

  const { nextGoforayRoles } = await import("../lib/goforay/bridge");
  return { fetch, nextGoforayRoles };
}
