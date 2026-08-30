import { afterEach, describe, expect, it, vi } from "vitest";

describe("role search availability", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("reports JuiceBox search as unavailable instead of falling back to Exa", async () => {
    vi.doMock("@/db", () => ({}));

    const { findGoforayRoles } = await import("../lib/goforay/bridge");

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scope only reaches JuiceBox, which is unconfigured here.
    const scope = { kind: "user", userId: "better-auth:candidate" } as never;
    const feed = await findGoforayRoles(scope);

    expect(feed.cards).toEqual([]);
    expect(feed.searching).toBe(false);
    expect(feed.source).toBe("juicebox");
    expect(feed.unavailable).toBe("GoForay integration is not configured.");
  });
});
