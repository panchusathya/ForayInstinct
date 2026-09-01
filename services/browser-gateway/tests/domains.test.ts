import { describe, expect, it } from "vitest";
import { registrableDomain, urlRegistrableDomain } from "../src/domains.ts";

describe("registrableDomain", () => {
  it("strips subdomains to the last two labels", () => {
    expect(registrableDomain("www.foo.com")).toBe("foo.com");
    expect(registrableDomain("foo.com")).toBe("foo.com");
    expect(registrableDomain("deep.nested.sub.foo.com")).toBe("foo.com");
  });

  it("keeps three labels under two-part TLDs", () => {
    expect(registrableDomain("a.b.co.uk")).toBe("b.co.uk");
    expect(registrableDomain("www.example.com.au")).toBe("example.com.au");
  });

  it("collapses ATS tenant subdomains to one registrable domain", () => {
    expect(registrableDomain("acme.myworkdayjobs.com")).toBe(
      "myworkdayjobs.com"
    );
    expect(registrableDomain("acme.wd5.myworkdayjobs.com")).toBe(
      "myworkdayjobs.com"
    );
    expect(registrableDomain("boards.greenhouse.io")).toBe("greenhouse.io");
  });

  it("normalizes case and trailing dots", () => {
    expect(registrableDomain("WWW.Foo.COM.")).toBe("foo.com");
  });
});

describe("urlRegistrableDomain", () => {
  it("extracts the registrable domain from a URL", () => {
    expect(urlRegistrableDomain("https://jobs.example.co.uk/apply?x=1")).toBe(
      "example.co.uk"
    );
  });

  it("returns undefined for hostless or invalid URLs", () => {
    expect(urlRegistrableDomain("about:blank")).toBeUndefined();
    expect(urlRegistrableDomain("not a url")).toBeUndefined();
  });
});
