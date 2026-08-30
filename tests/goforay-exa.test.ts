import { afterEach, describe, expect, it, vi } from "vitest";

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
});
