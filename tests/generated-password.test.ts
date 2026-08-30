import { describe, expect, it } from "vitest";
import { generatePassword } from "../lib/manager/generated-password";

describe("generated password", () => {
  it("meets the default structural policy", () => {
    const password = generatePassword();

    expect(password.length).toBe(20);
    expect(password).toMatch(/[A-Z]/u);
    expect(password).toMatch(/[a-z]/u);
    expect(password).toMatch(/\d/u);
    expect(password).toMatch(/[!@#$%^&*\-_=+]/u);
  });

  it("honors a tighter max length and optional symbol class", () => {
    const password = generatePassword({
      maxLength: 12,
      minLength: 12,
      requireSymbol: false,
    });

    expect(password).toHaveLength(12);
    expect(password).not.toMatch(/[!@#$%^&*\-_=+]/u);
  });

  it("does not emit the same value twice in a row", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
