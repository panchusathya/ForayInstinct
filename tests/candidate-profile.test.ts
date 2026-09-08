import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  candidateProfilePatchSchema,
  candidateProfileSchema,
  candidateProfileSummary,
  emptyCandidateProfile,
  isPlaceholderName,
  missingProfileFields,
  onlyUnset,
  parseProfilePatch,
  profileDiff,
  profileLimits,
  profilePatchOf,
  storedCandidateProfileSchema,
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

describe("a profile that exceeds a limit", () => {
  const oversized = {
    workHistory: [
      {
        company: "Acme",
        description: "x".repeat(profileLimits.description + 1),
        title: "Engineer",
      },
    ],
  };

  it("names the field instead of blanking the section", () => {
    // The array schemas used to `.catch([])`, so this patch parsed as an empty
    // work history and was saved as one, under a "Saved." message.
    const result = parseProfilePatch(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("workHistory.0.description");
    expect(result.issues[0]?.message).toMatch(/4000/u);
    expect(profilePatchOf(oversized)).toBeUndefined();
    expect(candidateProfileSchema.safeParse(oversized).success).toBe(false);
  });

  it("reports an empty patch as nothing to save, not as a failure", () => {
    expect(parseProfilePatch({})).toEqual({ ok: true, patch: undefined });
    expect(parseProfilePatch({ legalFirstName: "Ada" })).toEqual({
      ok: true,
      patch: { legalFirstName: "Ada" },
    });
  });

  it("reads a stored profile leniently, keeping the entries that still parse", () => {
    const stored = storedCandidateProfileSchema.parse({
      links: "nope",
      salaryMin: "lots",
      skills: ["TypeScript", "", 7, "SQL"],
      summary: "s".repeat(profileLimits.summary + 5),
      workAuthorization: "bogus",
      workHistory: Array.from(
        { length: profileLimits.workHistory + 1 },
        (_, index) => ({ company: `Company ${String(index)}`, title: "Role" })
      ),
    });

    expect(stored.skills).toEqual(["TypeScript", "SQL"]);
    expect(stored.links).toEqual([]);
    expect(stored.salaryMin).toBeNull();
    expect(stored.summary).toHaveLength(profileLimits.summary);
    expect(stored.workAuthorization).toBe("");
    expect(stored.workHistory).toHaveLength(profileLimits.workHistory);
    expect(stored.workHistory[0]?.company).toBe("Company 0");
    expect(storedCandidateProfileSchema.parse({})).toEqual(
      emptyCandidateProfile
    );
  });

  it("treats the phone sign-up placeholder as no name at all", () => {
    expect(isPlaceholderName("Phone user")).toBe(true);
    expect(isPlaceholderName(" phone user ")).toBe(true);
    expect(isPlaceholderName("Ada")).toBe(false);
    expect(isPlaceholderName("")).toBe(false);
  });
});

describe("the profile page's save", () => {
  it("sends only the fields that changed", () => {
    // The page used to send its whole snapshot, so a field left stale in one
    // tab was written back over the answer given in another.
    const base = candidateProfileSchema.parse({
      legalFirstName: "Ada",
      skills: ["Math"],
    });

    expect(profileDiff(base, base)).toEqual({});
    expect(
      profileDiff(base, {
        ...base,
        headline: "Engineer",
        skills: ["Math", "Engines"],
      })
    ).toEqual({ headline: "Engineer", skills: ["Math", "Engines"] });
    // Clearing a field is a change too.
    expect(profileDiff(base, { ...base, legalFirstName: "" })).toEqual({
      legalFirstName: "",
    });
  });

  it("lets a fact fill only a gap, and reads an empty list as a gap", () => {
    const stored = candidateProfileSchema.parse({
      legalFirstName: "Ada",
      links: [{ label: "Site", url: "https://ada.example" }],
    });

    expect(
      onlyUnset(stored, {
        legalFirstName: "Augusta",
        legalLastName: "King",
        links: [
          { label: "Home", url: "https://ADA.example" },
          { label: "LinkedIn", url: "https://linkedin.com/in/ada" },
        ],
        skills: ["Math"],
      })
    ).toEqual({
      legalLastName: "King",
      links: [
        { label: "Site", url: "https://ada.example" },
        { label: "LinkedIn", url: "https://linkedin.com/in/ada" },
      ],
      skills: ["Math"],
    });
  });
});
