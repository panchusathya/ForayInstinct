import { describe, expect, it } from "vitest";
import { decodoProxyForSession } from "../lib/browser";

describe("Decodo session URLs", () => {
  it("makes the Decodo username sticky for the browser session", () => {
    const proxy = decodoProxyForSession("abc123");
    expect(proxy.server).toBe("http://gate.decodo.com:7000");
    expect(proxy.username).toBe("user-session-abc123-sessionduration-30");
    expect(proxy.password).toBe("pass");
  });
});
