import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Workday post-login continuation", () => {
  it("treats the public posting page as an in-session step, not a handoff", () => {
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(workerInstructions).toContain("A successful ATS sign-in is not a stopping point");
    expect(workerInstructions).toMatch(/primary\s+\*\*Apply\*\* control/);
    expect(browserSkill).toContain("Workday post-login continuation");
    expect(browserSkill).toContain("primary control named **Apply** or **Apply Manually**");
    expect(browserSkill).toContain("not a reason to ask the candidate for takeover");
    expect(browserSkill).toContain('live-view overlay labelled "click to take control"');
  });
});
