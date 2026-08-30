import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn<(_headers: Headers) => Promise<null>>(),
}));

vi.mock("@/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));

import { proxy } from "../proxy";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue(null);
});

describe("authentication proxy", () => {
  it.each(["/eve/v1/linq", "/api/goforay/conversations"])(
    "lets the service-authenticated %s route reach its handler",
    async (pathname) => {
      const response = await proxy(
        new NextRequest(`https://apply.goforay.io${pathname}`)
      );

      expect(response.headers.get("location")).toBeNull();
      expect(mocks.getAuthSession).not.toHaveBeenCalled();
    }
  );

  it("still redirects an unauthenticated app request to sign-in", async () => {
    const response = await proxy(
      new NextRequest("https://apply.goforay.io/chat?draft=hello")
    );

    expect(response.headers.get("location")).toBe(
      "https://apply.goforay.io/sign-in?callbackUrl=%2Fchat%3Fdraft%3Dhello"
    );
    expect(mocks.getAuthSession).toHaveBeenCalledOnce();
  });
});
