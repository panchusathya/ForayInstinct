import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declinedSelfIdentificationFields,
  selfIdentificationSchema,
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
  });
});
