import { describe, expect, it } from "vitest";
import { browserCdpUrl, decodoProxyForSession } from "../lib/browser";

describe("Bright Data and Decodo session URLs", () => {
  it("embeds the session id in the Bright Data CDP username", () => {
    const url = new URL(browserCdpUrl("abc123"));
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("brd.superproxy.io");
    expect(decodeURIComponent(url.username)).toContain("-session-abc123");
    expect(decodeURIComponent(url.password)).toBe("test-password");
  });

  it("makes the Decodo username sticky for the browser session", () => {
    const proxy = decodoProxyForSession("abc123");
    expect(proxy.server).toBe("http://gate.decodo.com:7000");
    expect(proxy.username).toBe("user-session-abc123-sessionduration-30");
    expect(proxy.password).toBe("pass");
  });
});
