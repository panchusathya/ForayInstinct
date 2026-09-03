import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candidateProfilePatchSchema,
  candidateProfileSchema,
  candidateProfileSummary,
  emptyCandidateProfile,
  missingProfileFields,
  profilePatchOf,
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

describe("writing a partial profile", () => {
  it("never invents the fields a patch did not mention", () => {
    // Parsing through the patch schema alone fills in every default, so saving
    // one answer merged `workAuthorization: ""` over a real one and the profile
    // silently went backwards between applications.
    const patch = profilePatchOf({ legalFirstName: "Sathya" });

    expect(patch).toEqual({ legalFirstName: "Sathya" });
    expect(Object.keys(patch ?? {})).not.toContain("workAuthorization");
    expect(Object.keys(patch ?? {})).not.toContain("salaryCurrency");
  });

  it("pins why the partial schema alone cannot be trusted", () => {
    // This is the behaviour the guard exists for. If zod ever stops filling
    // defaults into a partial, the guard becomes redundant rather than wrong,
    // and this test says so instead of leaving the reasoning implicit.
    const inflated = candidateProfilePatchSchema.parse({ legalFirstName: "x" });

    expect(inflated).toHaveProperty("workAuthorization", "");
    expect(inflated).toHaveProperty("requiresSponsorshipNow", "");
  });

  it("treats a key carrying undefined as unstated", () => {
    // The schema hands such a key its default, and that default would then be
    // merged over a stored answer exactly like an explicit blank.
    expect(profilePatchOf({ workAuthorization: undefined })).toBeUndefined();
    expect(
      profilePatchOf({ legalFirstName: "Sathya", workAuthorization: undefined })
    ).toEqual({ legalFirstName: "Sathya" });
  });

  it("keeps a value the candidate did state", () => {
    expect(
      profilePatchOf({
        requiresSponsorshipNow: "no",
        workAuthorization: "us_citizen",
      })
    ).toEqual({
      requiresSponsorshipNow: "no",
      workAuthorization: "us_citizen",
    });
  });

  it("carries a contact email without making it block a start", () => {
    // Better Auth may still supply a verified address, so an empty one here
    // must never stop an application from starting.
    expect(profilePatchOf({ contactEmail: "sathya@example.com" })).toEqual({
      contactEmail: "sathya@example.com",
    });
    expect(missingProfileFields(emptyCandidateProfile)).not.toContain(
      "contact email"
    );
  });

  it("keeps nothing from an empty or invalid patch", () => {
    expect(profilePatchOf({})).toBeUndefined();
    expect(
      profilePatchOf({ workAuthorization: "not-an-option" })
    ).toBeUndefined();
  });
});
