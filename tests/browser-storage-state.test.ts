import { describe, expect, it } from "vitest";
import {
  isCookieSeedFailure,
  sanitizeStorageState,
} from "@/lib/browser/storage-state";

const now = Date.parse("2026-09-04T21:00:00Z");
const cookie = (overrides: Record<string, unknown>) => ({
  domain: ".greenhouse.io",
  expires: now / 1000 + 3600,
  httpOnly: false,
  name: "cc_ut",
  path: "/",
  sameSite: "Lax",
  secure: true,
  value: "x",
  ...overrides,
});

describe("seeding a saved browser state", () => {
  it("drops the cookies a fresh context refuses, and keeps the rest verbatim", () => {
    // Chromium rejects the whole Storage.setCookies batch when any one cookie
    // is excluded, which is how one stale cookie failed every application for
    // the workspace at the moment its browser was opened.
    const state = sanitizeStorageState(
      {
        cookies: [
          cookie({}),
          cookie({ expires: now / 1000 - 60, name: "expired" }),
          cookie({ name: "AWSALBCORS", sameSite: "None", secure: false }),
          cookie({ name: "__Secure-id", secure: false }),
          cookie({ expires: -1, name: "session" }),
        ],
        origins: [{ localStorage: [], origin: "https://greenhouse.io" }],
      },
      now
    );
    expect(state.cookies.map((row) => row.name)).toEqual(["cc_ut", "session"]);
    expect(state.origins).toEqual([
      { localStorage: [], origin: "https://greenhouse.io" },
    ]);
  });

  it("keeps one copy of a cookie exported twice for the same domain and path", () => {
    // _RCRTX03-samesite appeared twice in the refused batch; the later copy is
    // what a later Set-Cookie would have left behind.
    const state = sanitizeStorageState(
      {
        cookies: [
          cookie({ name: "_RCRTX03-samesite", value: "old" }),
          cookie({ name: "_RCRTX03-samesite", value: "new" }),
          cookie({
            domain: "job-boards.greenhouse.io",
            name: "_RCRTX03-samesite",
            value: "host",
          }),
        ],
        origins: [],
      },
      now
    );
    expect(state.cookies.map((row) => row.value)).toEqual(["new", "host"]);
  });

  it("recognizes a session that died seeding cookies", () => {
    expect(
      isCookieSeedFailure(
        new Error(
          "GatewayRequestError: browserContext.addCookies: Protocol error (Storage.setCookies): Overriding cc_ut, _fbp cookies is forbidden"
        )
      )
    ).toBe(true);
    expect(
      isCookieSeedFailure(new Error("Could not open https://x: timeout"))
    ).toBe(false);
  });
});
