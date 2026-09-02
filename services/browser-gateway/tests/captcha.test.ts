import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captchaDisableAutoSubmitMethod,
  captchaDisableAutoSubmitParams,
} from "../src/captcha.ts";

describe("Bright Data CAPTCHA auto-submit guard", () => {
  it("disables form auto-submit while leaving solve enabled", () => {
    expect(captchaDisableAutoSubmitMethod).toBe("Captcha.setAutoSolve");
    expect(captchaDisableAutoSubmitParams.autoSolve).toBe(true);
    expect(captchaDisableAutoSubmitParams.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submit_form: false, type: "usercaptcha" }),
        expect.objectContaining({ submit_form: false, type: "hcaptcha" }),
      ])
    );
  });

  it("sends the CDP command when a session is created", () => {
    const registry = readFileSync(
      new URL("../src/registry.ts", import.meta.url),
      "utf8"
    );
    expect(registry).toContain("captchaDisableAutoSubmitMethod");
    expect(registry).toContain("captchaDisableAutoSubmitParams");
    expect(registry).toContain("raw.send(");
  });
});
