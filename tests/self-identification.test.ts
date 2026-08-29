import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declinedSelfIdentificationFields,
  selfIdentificationSchema,
} from "../lib/self-identification";

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
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );

    for (const source of [browserSkill, workerInstructions]) {
      expect(source).toMatch(/voluntary self-identification/i);
      // The stall this replaces: the worker escalated a question the ATS
      // never required, and the application stopped there.
      expect(source).toContain("never a blocker");
      expect(source).toContain("decline option");
      expect(source).toMatch(/never infer (an answer|one) from/i);
    }
  });

  it("sends stored answers with the assignment and never asks for them", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");

    expect(instructions).toContain("`self_identification` with `get`");
    expect(instructions).toContain(
      "Never ask the candidate for gender, race/ethnicity, veteran status, or"
    );
    expect(instructions).toContain("tell it to decline that field");
  });
});
