import { describe, expect, it } from "vitest";
import { accessScopeForPhone, accessScopeForUser } from "../lib/access-scope";
import { normalizeAuthPhoneNumber } from "../auth/phone-number";

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
