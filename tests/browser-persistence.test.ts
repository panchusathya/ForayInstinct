import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  browserKeepAliveUntil,
  browserSessionMaxSeconds,
  clampBrowserTimeoutSeconds,
  shouldKeepAliveBrowser,
} from "../lib/browser";

describe("Decodo browser persistence", () => {
  it("launches Chromium with Decodo instead of attaching to a remote browser", () => {
    const source = readFileSync("lib/browser.ts", "utf8");

    expect(source).toContain("playwrightChromium.launch(");
    expect(source).toContain("proxy: decodoProxyForSession(sessionId)");
    expect(source).toContain("browser.newContext()");
    expect(source).not.toContain("connectOverCDP");
    expect(source).not.toContain("Target.createBrowserContext");
  });

  it("persists browser storage beyond the Chromium process", () => {
    const source = readFileSync("lib/browser.ts", "utf8");

    expect(source).toContain("browser-storage:");
    expect(source).toContain("origins: state?.origins ?? []");
    expect(source).toContain("sessionStorage");
    expect(source).toContain("addInitScript");
  });

  it("keeps the existing one-hour browser session ceiling", () => {
    expect(clampBrowserTimeoutSeconds()).toBe(900);
    expect(clampBrowserTimeoutSeconds(120)).toBe(900);
    expect(clampBrowserTimeoutSeconds(3600)).toBe(3600);
    expect(clampBrowserTimeoutSeconds(259_200)).toBe(browserSessionMaxSeconds);

    const createdAt = "2026-08-29T00:00:00.000Z";
    const now = Date.parse("2026-08-29T00:50:00.000Z");
    expect(browserKeepAliveUntil(createdAt, 900, now)).toBe(
      "2026-08-29T01:00:00.000Z"
    );
    expect(
      shouldKeepAliveBrowser(
        { keepAliveUntil: "2026-08-29T00:15:00.000Z" },
        now
      )
    ).toBe(false);
  });
});
