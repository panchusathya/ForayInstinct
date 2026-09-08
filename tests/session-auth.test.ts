import { describe, expect, it } from "vitest";
import {
  accessScopeForPhone,
  accessScopeForUser,
  scopesForAuthUser,
} from "../lib/access-scope";
import {
  legacyNormalizeAuthPhoneNumber,
  normalizeAuthPhoneNumber,
} from "../auth/phone-number";

describe("multi-user request identity", () => {
  it("derives stable personal workspaces without exposing provider ids", () => {
    const first = accessScopeForUser("better-auth:123");
    const second = accessScopeForUser("better-auth:456");

    expect(first).toEqual(accessScopeForUser("better-auth:123"));
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.workspaceId).not.toContain("better-auth:123");
  });

  it("defaults phone numbers to the +1 country code", () => {
    expect(normalizeAuthPhoneNumber("(202) 555-0123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("1 202 555 0123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("+44 7911 123456")).toBe("+447911123456");
    expect(normalizeAuthPhoneNumber("not-a-number")).toBeUndefined();
  });

  it("does not invent a US country code for a number that is not one", () => {
    // A UK number texted without its country code became +107700900123: the
    // candidate's workspace key and the phone typed into every form.
    expect(normalizeAuthPhoneNumber("07700900123")).toBeUndefined();
    expect(normalizeAuthPhoneNumber("+44 7700 900123")).toBe("+447700900123");
    expect(normalizeAuthPhoneNumber("2025550123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("12025550123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("555-0123")).toBeUndefined();
    // The old reading is kept only to find and adopt the workspace it keyed.
    expect(legacyNormalizeAuthPhoneNumber("07700900123")).toBe("+107700900123");
    expect(legacyNormalizeAuthPhoneNumber("2025550123")).toBe("+12025550123");
  });

  it("uses the normalized phone as one stable cross-channel workspace", () => {
    const fromText = accessScopeForPhone("+12025550123");
    const fromWeb = accessScopeForPhone(
      normalizeAuthPhoneNumber("(202) 555-0123") ?? ""
    );

    expect(fromText).toEqual(fromWeb);
    expect(fromText.workspaceId).toMatch(/^phone:[a-f0-9]{32}$/u);
    expect(fromText.workspaceId).not.toContain("2025550123");
  });
});

describe("one scope derivation for a signed-in user", () => {
  it("keys a verified US number by phone and adopts the personal workspace", () => {
    const scopes = scopesForAuthUser({ id: "u1", phoneNumber: "+12125550123" });

    expect(scopes.scope).toEqual(accessScopeForPhone("+12125550123"));
    expect(scopes.legacyScopes).toEqual([accessScopeForUser("better-auth:u1")]);
  });

  it("keeps a UK candidate in the workspace the old +1 reading gave them", () => {
    // The old rule put +1 in front of anything without a country code, so a
    // UK candidate who typed their number without one was keyed by a
    // US-shaped number. The corrected rule reads nothing from that input, so
    // the workspace they already have stays theirs.
    const scopes = scopesForAuthUser({ id: "u2", phoneNumber: "447700900123" });

    expect(scopes.scope).toEqual(accessScopeForPhone("+1447700900123"));
    expect(scopes.legacyScopes).toEqual([]);

    // Written with its country code, the number keys the corrected workspace.
    const corrected = scopesForAuthUser({
      id: "u2",
      phoneNumber: "+447700900123",
    });
    expect(corrected.scope).toEqual(accessScopeForPhone("+447700900123"));
    expect(corrected.legacyScopes).toEqual([
      accessScopeForUser("better-auth:u2"),
    ]);
  });

  it("keeps the personal workspace when there is no usable number", () => {
    expect(scopesForAuthUser({ id: "u4" })).toEqual({
      legacyScopes: [],
      scope: accessScopeForUser("better-auth:u4"),
    });
    expect(scopesForAuthUser({ id: "u4", phoneNumber: "12" })).toEqual({
      legacyScopes: [],
      scope: accessScopeForUser("better-auth:u4"),
    });
  });
});
