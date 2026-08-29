import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  browserbaseMaxSessionSeconds,
  browserKeepAliveUntil,
  clampBrowserTimeoutSeconds,
  shouldKeepAliveBrowser,
} from "../lib/browser";

describe("Browserbase session persistence", () => {
  it("keeps browser state in chat state and a Browserbase Context", () => {
    const source = readFileSync("lib/browser.ts", "utf8");
    expect(source).toContain("browser-storage:");
    expect(source).toContain("browserbaseContextId");
    expect(source).toContain("context: { id: contextId, persist: true }");
    expect(source).toContain("origins: state?.origins ?? []");
    expect(source).toContain("sessionStorage");
    expect(source).toContain("addInitScript");
    expect(source).not.toContain("Target.createBrowserContext");
    expect(source).not.toContain("DECODO_PROXY_URL");
    expect(source).not.toContain("browser.newContext(");
    expect(source).not.toContain("Proxy.useSession");
  });

  it("clamps keepalive to Browserbase's six-hour session maximum", () => {
    expect(clampBrowserTimeoutSeconds()).toBe(900);
    expect(clampBrowserTimeoutSeconds(120)).toBe(900);
    expect(clampBrowserTimeoutSeconds(3600)).toBe(3600);
    expect(clampBrowserTimeoutSeconds(259_200)).toBe(
      browserbaseMaxSessionSeconds
    );
  });

  it("does not keep a session alive past Browserbase's max lifetime", () => {
    const createdAt = "2026-08-29T00:00:00.000Z";
    const now = Date.parse("2026-08-29T05:50:00.000Z");
    expect(
      browserKeepAliveUntil(createdAt, browserbaseMaxSessionSeconds, now)
    ).toBe("2026-08-29T06:00:00.000Z");
    expect(
      shouldKeepAliveBrowser(
        { keepAliveUntil: "2026-08-29T00:15:00.000Z" },
        now
      )
    ).toBe(false);
    expect(
      shouldKeepAliveBrowser(
        { keepAliveUntil: "2026-08-29T06:00:00.000Z" },
        now
      )
    ).toBe(true);
  });
});
