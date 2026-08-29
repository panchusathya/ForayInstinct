import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserKeepAliveUntil,
  brightDataMaxSessionSeconds,
  clampBrowserTimeoutSeconds,
  shouldKeepAliveBrowser,
} from "../lib/browser";

const store = vi.hoisted(
  () =>
    new Map<
      string,
      {
        keepAliveUntil?: string;
        liveView: string;
        timeoutSeconds?: number;
      }
    >()
);

const touch = vi.hoisted(() => ({
  connectOverCDP:
    vi.fn<(url: string, options?: { timeout?: number }) => Promise<never>>(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: (url: string, options?: { timeout?: number }) =>
      touch.connectOverCDP(url, options),
  },
}));

vi.mock("@/db", () => {
  const chatStateValues = {
    expiresAt: "expiresAt",
    key: "key",
    value: "value",
  };
  return {
    chatStateValues,
    db: {
      delete() {
        return {
          async where() {
            return undefined;
          },
        };
      },
      insert() {
        return {
          values() {
            return {
              async onConflictDoUpdate() {
                return undefined;
              },
            };
          },
        };
      },
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve(
                  [...store.entries()].map(([key, value]) => ({
                    key,
                    value,
                  }))
                );
              },
            };
          },
        };
      },
    },
  };
});

describe("Bright Data session persistence", () => {
  beforeEach(() => {
    store.clear();
    touch.connectOverCDP.mockReset();
  });

  it("keeps browser state in chat state instead of Playwright newContext", () => {
    const source = readFileSync("lib/browser.ts", "utf8");
    expect(source).toContain("browser-storage:");
    expect(source).toContain("keepAliveUntil");
    expect(source).toContain('"Proxy.useSession"');
    expect(source).toContain("origins: state?.origins ?? []");
    expect(source).toContain("sessionStorage");
    expect(source).toContain("addInitScript");
    expect(source).not.toContain("Target.createBrowserContext");
    expect(source).not.toContain("DECODO_PROXY_URL");
    expect(source).not.toContain("browser.newContext(");
    expect(source).not.toContain("disposeOnDetach: true");
  });

  it("clamps keepalive to Bright Data's 60-minute session maximum", () => {
    expect(clampBrowserTimeoutSeconds()).toBe(900);
    expect(clampBrowserTimeoutSeconds(120)).toBe(900);
    expect(clampBrowserTimeoutSeconds(3600)).toBe(3600);
    expect(clampBrowserTimeoutSeconds(259_200)).toBe(
      brightDataMaxSessionSeconds
    );
  });

  it("does not keep a session alive past Bright Data's max lifetime", () => {
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
    expect(
      shouldKeepAliveBrowser(
        { keepAliveUntil: "2026-08-29T01:00:00.000Z" },
        now
      )
    ).toBe(true);
  });

  it("pings only browsers whose keepalive deadline is still in the future", async () => {
    store.set("browser-meta:live", {
      keepAliveUntil: new Date(Date.now() + 60_000).toISOString(),
      liveView: "https://inspect.brightdata.test/live",
      timeoutSeconds: 900,
    });
    store.set("browser-meta:expired", {
      keepAliveUntil: new Date(Date.now() - 1_000).toISOString(),
      liveView: "https://inspect.brightdata.test/expired",
      timeoutSeconds: 900,
    });
    touch.connectOverCDP.mockRejectedValue(new Error("cdp down"));

    const { keepAliveActiveBrowsers } = await import("../lib/browser");
    await keepAliveActiveBrowsers();

    expect(touch.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(touch.connectOverCDP.mock.calls[0]?.[0]).toContain("-session-live");
  });
});
