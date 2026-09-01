import { describe, expect, it } from "vitest";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import { gatewayErrorSchema } from "../../../lib/browser/contract.ts";
import { createApp } from "../src/app.ts";
import { sessionGone, sessionNotFound } from "../src/errors.ts";
import { fakeSessions } from "./fake-sessions.ts";

const secret = "test-secret";
const authed = { headers: { authorization: `Bearer ${secret}` } };

function appWithDescribe(describeImpl: (id: string) => never) {
  return createApp({
    authSecret: secret,
    sessions: fakeSessions({ describe: describeImpl }),
  });
}

describe("session error mapping", () => {
  it("maps an unknown session to a 404 session_not_found", async () => {
    const app = appWithDescribe((id) => {
      throw sessionNotFound(id);
    });
    const response = await app.request("/sessions/nope", authed);
    expect(response.status).toBe(404);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("session_not_found");
    expect(body.error.message).toContain("nope");
  });

  it("maps a dead session to a 410 session_gone", async () => {
    const app = appWithDescribe(() => {
      throw sessionGone({ deathReason: "session_gone", sessionId: "dead-1" });
    });
    const response = await app.request("/sessions/dead-1", authed);
    expect(response.status).toBe(410);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("session_gone");
    expect(body.error.domains).toBeUndefined();
  });

  it("attributes a cross-domain death with the domains involved", async () => {
    const app = appWithDescribe(() => {
      throw sessionGone({
        deathReason: "cross_domain_navigation",
        lastCrossDomain: { from: "foo.com", to: "bar.com" },
        sessionId: "dead-2",
      });
    });
    const response = await app.request("/sessions/dead-2", authed);
    expect(response.status).toBe(410);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("cross_domain_navigation");
    expect(body.error.domains).toEqual(["foo.com", "bar.com"]);
    expect(body.error.message).toContain("foo.com");
    expect(body.error.message).toContain("bar.com");
  });

  it("maps invalid bodies to a 400 invalid_request", async () => {
    const app = appWithDescribe((id) => {
      throw sessionNotFound(id);
    });
    const response = await app.request("/sessions/x/playwright", {
      ...authed,
      body: JSON.stringify({ code: "" }),
      headers: { ...authed.headers, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(400);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("invalid_request");
  });
});
