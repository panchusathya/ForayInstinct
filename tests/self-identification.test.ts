import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declinedSelfIdentificationFields,
  selfIdentificationSchema,
  selfIdentificationSignature,
} from "../lib/self-identification";

const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

const browserSkillText = () =>
  flat("agent/subagents/worker/skills/browser-execution/SKILL.md");
const workerInstructionsText = () =>
  flat("agent/subagents/worker/instructions.md");
const coordinatorText = () => flat("agent/instructions.md");

describe("voluntary self-identification", () => {
  it("reports every unanswered field as declined", () => {
    expect(declinedSelfIdentificationFields({})).toEqual([
      "disabilityStatus",
      "gender",
      "raceEthnicity",
      "veteranStatus",
    ]);
    expect(declinedSelfIdentificationFields({ gender: "Male" })).toEqual([
      "disabilityStatus",
      "raceEthnicity",
      "veteranStatus",
    ]);
  });

  it("accepts a partial answer set", () => {
    const parsed = selfIdentificationSchema.parse({ gender: "Male" });

    expect(parsed).toEqual({ gender: "Male" });
  });

  it("rejects an empty answer rather than storing a blank disclosure", () => {
    expect(selfIdentificationSchema.safeParse({ gender: "" }).success).toBe(
      false
    );
  });

  it("declines an unanswered EEO field instead of stalling the application", () => {
    for (const source of [browserSkillText(), workerInstructionsText()]) {
      expect(source).toMatch(/voluntary self-identification/i);
      expect(source).toContain("decline option");
      expect(source).toMatch(/never infer (an answer|one) from/i);
    }
  });

  it("asks rather than demanding a takeover when a field is forced", () => {
    // A form that requires a gender selection and offers no decline option
    // left the worker with no sanctioned escalation, so it asked the candidate
    // to take over the application instead of asking the question.
    for (const source of [browserSkillText(), workerInstructionsText()]) {
      expect(source).toContain("never a takeover");
      expect(source).toContain("required and");
      expect(source).toContain("no decline option");
      expect(source).toContain("`Needs user input:`");
      expect(source).toContain("visible options");
    }
  });

  it("signs a declined disability form with the name and today's date", () => {
    // Declining the CC-305 question leaves its signature block empty, and the
    // page will not advance until a name and date are filled. The worker has
    // no clock, so both travel with the assignment.
    expect(
      selfIdentificationSignature(
        "Alex Rivera",
        new Date("2026-08-29T21:00:00Z")
      )
    ).toEqual({
      day: "29",
      isoDate: "2026-08-29",
      month: "08",
      name: "Alex Rivera",
      year: "2026",
    });
    expect(
      selfIdentificationSignature(
        "Alex Rivera",
        new Date("2026-08-29T02:30:00Z"),
        "America/Los_Angeles"
      )
    ).toEqual({
      day: "28",
      isoDate: "2026-08-28",
      month: "08",
      name: "Alex Rivera",
      year: "2026",
    });
    expect(
      selfIdentificationSignature(
        "Alex Rivera",
        new Date("2026-01-05T00:00:00Z")
      ).isoDate
    ).toBe("2026-01-05");
  });

  it("fills the signature block rather than treating it as a blocker", () => {
    for (const source of [browserSkillText(), workerInstructionsText()]) {
      expect(source).toContain("CC-305");
      expect(source).toContain("signature");
      expect(source).toMatch(/name and today's date/i);
      expect(source).toContain("`month`, `day`, and `year`");
      expect(source).toContain("form already pre-filled");
      expect(source).toContain("Workday router");
      expect(source).not.toMatch(/signature block is a takeover/i);
    }
  });

  it("sends stored answers with the assignment and resumes after asking", () => {
    const instructions = coordinatorText();

    expect(instructions).toContain("`self_identification` with `get`");
    expect(instructions).toContain("Never infer gender, race/ethnicity");
    expect(instructions).toContain("tell it to decline");
    // The candidate is asked, the answer is stored, and the same worker
    // finishes the application rather than handing it back to them.
    expect(instructions).toContain("required with no decline option");
    expect(instructions).toContain("`self_identification` `save`");
    expect(instructions).toContain(
      "resume that worker with its `agentId` to finish the"
    );
    expect(instructions).toContain("Never turn that question into a takeover");
    // The disability form's signature block needs a name and a date the
    // worker cannot produce on its own.
    expect(instructions).toContain("returned `signature`");
    expect(instructions).toContain("no clock and no name");
  });
});
