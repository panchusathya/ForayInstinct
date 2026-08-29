import { describe, expect, it } from "vitest";
import { browserCdpUrl, normalizeBrightDataBrowserAuth } from "../lib/browser";

describe("Bright Data Browser API session URLs", () => {
  it("uses the configured Bright Data Browser API credentials", () => {
    const url = new URL(browserCdpUrl("abc123"));
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("brd.superproxy.io");
    expect(decodeURIComponent(url.username)).toContain("-session-abc123");
    expect(decodeURIComponent(url.password)).toBe("test-password");
  });

  it("normalizes a copied Bright Data CDP endpoint to credentials", () => {
    expect(
      normalizeBrightDataBrowserAuth(
        "wss://brd-customer-test-zone-browser:test-password@brd.superproxy.io:9222"
      )
    ).toBe("brd-customer-test-zone-browser:test-password");
  });
});
