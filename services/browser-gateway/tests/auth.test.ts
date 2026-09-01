import { describe, expect, it } from "vitest";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import { gatewayErrorSchema } from "../../../lib/browser/contract.ts";
import { createApp } from "../src/app.ts";
import { fakeSessions } from "./fake-sessions.ts";

const app = createApp({ authSecret: "test-secret", sessions: fakeSessions() });

describe("auth middleware", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await app.request("/sessions");
    expect(response.status).toBe(401);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects requests with the wrong token", async () => {
    const response = await app.request("/sessions", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    expect(response.status).toBe(401);
    const body = gatewayErrorSchema.parse(await response.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects non-bearer authorization schemes", async () => {
    const response = await app.request("/sessions", {
      headers: { authorization: "Basic dGVzdC1zZWNyZXQ=" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const response = await app.request("/sessions", {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
  });

  it("leaves /health open", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      draining: false,
      ok: true,
      sessions: 0,
    });
  });
});
