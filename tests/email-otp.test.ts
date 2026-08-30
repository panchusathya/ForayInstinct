import { describe, expect, it } from "vitest";
import {
  buildEmailOtpSearchQuery,
  extractEmailOtp,
} from "@/agent/lib/google-workspace/email-otp";

describe("email OTP extraction", () => {
  it("reads labeled 4, 6, and 8 digit codes", () => {
    expect(extractEmailOtp("Your code is 1234. Do not share it.")).toBe("1234");
    expect(extractEmailOtp("Your verification code is 123456")).toBe("123456");
    expect(extractEmailOtp("84729103 is your verification code")).toBe(
      "84729103"
    );
  });

  it("reads spaced, dashed, and alphanumeric labeled codes", () => {
    expect(extractEmailOtp("Enter the code: 12 34 56")).toBe("123456");
    expect(extractEmailOtp("OTP: G-123456")).toBe("G123456");
    expect(extractEmailOtp("Your one-time code is AB12CD")).toBe("AB12CD");
  });

  it("prefers a labeled code over other numbers in the same email", () => {
    expect(
      extractEmailOtp("Order 998877. Your code is 123456. Tracking 445566.")
    ).toBe("123456");
  });

  it("ignores tracking numbers, dates, and unlabeled copy", () => {
    expect(extractEmailOtp("Your tracking number is 123456")).toBeNull();
    expect(extractEmailOtp("Your interview is on 08/29/2026")).toBeNull();
    expect(extractEmailOtp("Thanks for applying to role 12345")).toBeNull();
    expect(extractEmailOtp("See you in 2026")).toBeNull();
  });
});

describe("email OTP Gmail query", () => {
  it("scopes search to recent verification mail and optional hints", () => {
    expect(buildEmailOtpSearchQuery({})).toContain("newer_than:15m");
    expect(buildEmailOtpSearchQuery({})).toContain("otp");
    expect(
      buildEmailOtpSearchQuery({
        fromHint: "noreply@myworkday.com",
        subjectHint: 'Verify (code) "now"',
      })
    ).toBe(
      'newer_than:15m (otp OR passcode OR pin OR verification OR "one-time" OR "one time" OR "security code" OR "verification code") from:noreply@myworkday.com subject:"Verify code now"'
    );
    expect(buildEmailOtpSearchQuery({ fromHint: "Workday" })).toContain(
      '"Workday"'
    );
  });
});
