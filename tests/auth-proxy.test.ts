import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn<(_headers: Headers) => Promise<unknown>>(),
}));

vi.mock("@/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));

import { isPublicPath, proxy } from "../proxy";

describe("auth proxy allowlist", () => {
  beforeEach(() => {
    mocks.getAuthSession.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "/sign-in",
    "/api/auth/ok",
    "/eve/v1/health",
    "/eve/v1/linq",
    "/eve/v1/session/abc/stream",
    "/api/goforay/conversations",
    "/api/job-card-png",
  ])("lets %s through without a session cookie", async (pathname) => {
    expect(isPublicPath(pathname)).toBe(true);
    const response = await proxy(
      new NextRequest(`https://assistant.example${pathname}`)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });

  it("redirects cookie-gated app routes when unauthenticated", async () => {
    expect(isPublicPath("/chat")).toBe(false);
    const response = await proxy(
      new NextRequest("https://assistant.example/chat")
    );
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/sign-in"
    );
  });

  it("lets cookie-gated app routes through when the session is verified", async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    const response = await proxy(
      new NextRequest("https://assistant.example/chat")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
