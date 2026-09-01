import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeBrowserSessionFailure } from "@/agent/subagents/worker/lib/challenge-diagnostics";

// lib/env.ts reads process.env at import time, so the gateway configuration
// has to be stubbed before the provider module loads.
vi.stubEnv("BROWSER_GATEWAY_URL", "https://gateway.example.com");
vi.stubEnv("BROWSER_GATEWAY_SECRET", "gateway-secret");
vi.resetModules();
const { GatewayRequestError, gatewayBrowserProvider } =
  await import("@/lib/browser/gateway-provider");

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("gateway browser provider", () => {
  it("sends the bearer secret and validates the session descriptor", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        captcha_detected: false,
        created_at: "2026-08-31T00:00:00.000Z",
        devtools_url: "https://devtools.example.com/inspect",
        session_id: "gw-1",
        status: "active",
        viewport: { height: 800, width: 1280 },
      })
    );

    const session = await gatewayBrowserProvider.createSession({
      startUrl: "https://jobs.example.com/apply",
      timeoutSeconds: 900,
    });

    expect(session.session_id).toBe("gw-1");
    expect(session.devtools_url).toBe("https://devtools.example.com/inspect");
    // No live view on the gateway; the descriptor must not invent one.
    expect(session.browser_live_view_url).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://gateway.example.com/sessions");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer gateway-secret"
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      start_url: "https://jobs.example.com/apply",
      ttl_seconds: 900,
    });
  });

  it("preserves the Kernel playwright envelope byte-for-byte", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { clicked: true }, success: true })
    );

    const response = await gatewayBrowserProvider.executePlaywright("gw-1", {
      code: "return { clicked: true };",
    });

    expect(response).toEqual({ result: { clicked: true }, success: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      code: "return { clicked: true };",
      timeout_sec: 30,
    });
  });

  it("throws errors the session-failure taxonomy already classifies", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "session_gone", message: "the browser closed" } },
        410
      )
    );

    const failure = await gatewayBrowserProvider
      .getSession("gw-dead")
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(describeBrowserSessionFailure(failure)).toBe("session_gone");
  });

  it("classifies a cross-domain death distinctly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "cross_domain_navigation",
            domains: ["a.example.com", "b.example.net"],
            message: "session left its initial domain",
          },
        },
        410
      )
    );

    const failure = await gatewayBrowserProvider
      .getSession("gw-hopped")
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(describeBrowserSessionFailure(failure)).toBe(
      "cross_domain_navigation"
    );
  });

  it("returns exported storage state from a delete", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ storage_state: { cookies: [], origins: [] } })
    );

    const result = await gatewayBrowserProvider.deleteSession("gw-1");
    expect(result.storageState).toEqual({ cookies: [], origins: [] });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("attaches CDP targets once and routes sends by ref", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          iframes: [{ ref: "frame-1", url: "https://cdn.example.com/w" }],
          page: { ref: "page-1", url: "https://jobs.example.com/apply" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ result: { value: 1 } }));

    const outcome = await gatewayBrowserProvider.withCdpPage(
      "gw-1",
      async ({ origin, send, sessionRefs, url }) => {
        expect(origin).toBe("https://jobs.example.com");
        expect(url).toBe("https://jobs.example.com/apply");
        expect(sessionRefs).toEqual(["page-1", "frame-1"]);
        return send("Runtime.evaluate", { expression: "1" }, "frame-1");
      }
    );

    expect(outcome).toEqual({ value: 1 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      method: "Runtime.evaluate",
      params: { expression: "1" },
      session_ref: "frame-1",
    });
  });

  it("rejects a malformed gateway response instead of passing it through", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }));

    await expect(gatewayBrowserProvider.getSession("gw-1")).rejects.toThrow(
      "unexpected GET /sessions/gw-1 response shape"
    );
  });
});
