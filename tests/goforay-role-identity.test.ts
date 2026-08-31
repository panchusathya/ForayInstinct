import { describe, expect, it } from "vitest";
import {
  normalizeJobUrl,
  roleKey,
  roleKeys,
} from "@/lib/goforay/role-identity";

describe("goforay role identity", () => {
  it("prefers a posting id so one posting behind two URLs is one role", () => {
    const key = roleKey({
      posting_id: "posting-1",
      url: "https://boards.greenhouse.io/acme/jobs/1",
    });
    expect(key).toBe("posting:posting-1");
    expect(
      roleKey({
        posting_id: "posting-1",
        url: "https://acme.com/careers/analyst-1",
      })
    ).toBe(key);
  });

  it("collapses www, case, trailing slash, fragment and tracking params", () => {
    expect(
      normalizeJobUrl(
        "https://WWW.Example.com/jobs/123?utm_source=x&gh_src=y&ref=z#top"
      )
    ).toBe(normalizeJobUrl("https://example.com/jobs/123/"));
  });

  it("keeps params that identify which posting a path points at", () => {
    // Two different Greenhouse jobs share one path; collapsing them would hide
    // a real role, which is why the param filter is a denylist.
    expect(
      normalizeJobUrl("https://boards.greenhouse.io/acme?gh_jid=1")
    ).not.toBe(normalizeJobUrl("https://boards.greenhouse.io/acme?gh_jid=2"));
  });

  it("preserves path case, because Workday posting ids are case-sensitive", () => {
    expect(
      normalizeJobUrl("https://acme.wd1.myworkdayjobs.com/en-US/job/ABC123")
    ).not.toBe(
      normalizeJobUrl("https://acme.wd1.myworkdayjobs.com/en-US/job/abc123")
    );
  });

  it("returns a stable key for a malformed URL instead of throwing", () => {
    expect(normalizeJobUrl("  Not A URL  ")).toBe("not a url");
    expect(roleKey({ url: "not a url" })).toBe("url:not a url");
  });

  it("offers both identities so a curated role is recognised as a public hit", () => {
    // The curated feed carries a posting id and public search never does, so
    // matching on the primary key alone missed the case the presented-roles
    // store exists for: the same posting coming back from the other source.
    const curated = {
      posting_id: "posting-1",
      url: "https://boards.greenhouse.io/acme/jobs/1",
    };
    const publicHit = { url: "https://boards.greenhouse.io/acme/jobs/1" };

    expect(roleKeys(curated)).toEqual([
      "posting:posting-1",
      "url:boards.greenhouse.io/acme/jobs/1",
    ]);
    expect(
      roleKeys(publicHit).some((key) => roleKeys(curated).includes(key))
    ).toBe(true);
  });

  it("does not repeat the url key when there is no posting id", () => {
    expect(roleKeys({ url: "https://acme.com/careers/1" })).toEqual([
      "url:acme.com/careers/1",
    ]);
  });
});
