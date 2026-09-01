import { describe, expect, it } from "vitest";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import { gatewayErrorSchema } from "../../../lib/browser/contract.ts";
import { createApp } from "../src/app.ts";
import {
  CdpRefCache,
  unknownRefError,
  type CdpSessionLike,
} from "../src/cdp.ts";
import { GatewayHttpError } from "../src/errors.ts";
import { fakeSessions } from "./fake-sessions.ts";

function fakeCdpSession(): CdpSessionLike & { detached: number } {
  const session = {
    detach: () => {
      session.detached += 1;
      return Promise.resolve();
    },
    detached: 0,
    send: () => Promise.resolve({}),
  };
  return session;
}

describe("CdpRefCache", () => {
  it("resolves the page ref when no explicit ref is given", () => {
    const cache = new CdpRefCache();
    const session = fakeCdpSession();
    cache.register(session, "page");
    expect(cache.resolve(undefined)).toBe(session);
  });

  it("returns undefined with nothing attached so callers auto-attach", () => {
    const cache = new CdpRefCache();
    expect(cache.resolve(undefined)).toBeUndefined();
  });

  it("throws a 400 execution_failed for an unknown ref", () => {
    const cache = new CdpRefCache();
    let thrown: unknown;
    try {
      cache.resolve("no-such-ref");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayHttpError);
    if (!(thrown instanceof GatewayHttpError)) {
      throw new Error("expected a GatewayHttpError");
    }
    expect(thrown.status).toBe(400);
    const body = gatewayErrorSchema.parse(thrown.body);
    expect(body.error.code).toBe("execution_failed");
    expect(body.error.message).toContain("cdp-targets");
  });

  it("invalidates and detaches previous refs on re-attach", () => {
    const cache = new CdpRefCache();
    const first = fakeCdpSession();
    const firstRef = cache.register(first, "page");
    cache.reset();
    const second = fakeCdpSession();
    cache.register(second, "page");
    expect(first.detached).toBe(1);
    expect(() => cache.resolve(firstRef)).toThrow(GatewayHttpError);
    expect(cache.resolve(undefined)).toBe(second);
  });

  it("expires refs after the inactivity TTL and detaches them", () => {
    let now = 0;
    const cache = new CdpRefCache(120_000, () => now);
    const session = fakeCdpSession();
    const ref = cache.register(session, "page");
    now = 119_000;
    expect(cache.resolve(ref)).toBe(session); // activity refreshes the ref
    now = 119_000 + 120_001;
    expect(() => cache.resolve(ref)).toThrow(GatewayHttpError);
    expect(session.detached).toBe(1);
    expect(cache.resolve(undefined)).toBeUndefined();
  });
});

describe("cdp route error shape", () => {
  it("returns the unknown-ref failure as a parseable 400", async () => {
    const sessions = fakeSessions({
      cdp: () => {
        throw unknownRefError("stale-ref");
      },
    });
    const app = createApp({ authSecret: "s", sessions });
    const response = await app.request("/sessions/x/cdp", {
      body: JSON.stringify({ method: "Page.enable", session_ref: "stale-ref" }),
      headers: {
        authorization: "Bearer s",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(400);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("execution_failed");
    expect(body.error.message).toContain("stale-ref");
  });
});
