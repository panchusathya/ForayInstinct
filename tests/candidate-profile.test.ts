import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candidateProfileSchema,
  candidateProfileSummary,
  emptyCandidateProfile,
  missingProfileFields,
} from "../lib/candidate-profile";

describe("candidate profile", () => {
  it("starts empty and asks only for the gaps that block an application", () => {
    expect(candidateProfileSchema.parse({})).toEqual(emptyCandidateProfile);
    // Reciting all nine at intake read as an interrogation. A form that wants
    // a deferrable field asks for it through a `Needs user input:` blocker.
    expect(missingProfileFields(emptyCandidateProfile)).toEqual([
      "legal first name",
      "legal last name",
      "work authorization",
      "sponsorship needed now",
      "work history",
    ]);
  });

  it("never asks for a fact the resume on file already carries", () => {
    expect(
      missingProfileFields(emptyCandidateProfile, { hasResume: true })
    ).toEqual(["work authorization", "sponsorship needed now"]);
  });

  it("renders a compact assignment block without secrets", () => {
    const profile = candidateProfileSchema.parse({
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      locationCity: "London",
      locationCountryCode: "GB",
      locationRegion: "England",
      preferredName: "Ada",
      requiresSponsorshipFuture: "no",
      requiresSponsorshipNow: "no",
      workAuthorization: "us_visa_no_sponsorship",
      workHistory: [
        {
          company: "Analytical Engines",
          current: false,
          description: "Notes on the engine.",
          title: "Mathematician",
        },
      ],
    });

    const summary = candidateProfileSummary(profile, {
      email: "ada@example.com",
      name: "Ada Lovelace",
      phone: "+15555550123",
    });

    expect(summary.truncated).toBe(false);
    expect(summary.text).toContain("Name: Ada Lovelace");
    expect(summary.text).toContain("Email: ada@example.com");
    expect(summary.text).toContain(
      "Work authorization: us_visa_no_sponsorship"
    );
    expect(summary.text).toContain("Analytical Engines");
    expect(summary.text).not.toMatch(/password|ssn|social security/i);
    expect(missingProfileFields(profile)).toEqual([]);
  });

  it("sends the assignment from the coordinator tool before an ATS fill", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const tool = readFileSync("agent/tools/candidate_profile.ts", "utf8");

    expect(instructions).toContain("`candidate_profile` with `get`");
    expect(instructions).toContain("`candidate_profile` `save`");
    expect(instructions).toContain("Paste the profile `assignment`");
    expect(tool).toContain("paste the returned `assignment`");
  });
});
