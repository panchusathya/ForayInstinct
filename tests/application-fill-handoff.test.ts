import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootInstructions = readFileSync("agent/instructions.md", "utf8");
const workerInstructions = readFileSync(
  "agent/subagents/worker/instructions.md",
  "utf8"
);
const applicationTools = readFileSync(
  "agent/tools/goforay-applications.ts",
  "utf8"
);
const browserSkill = readFileSync(
  "agent/subagents/worker/skills/browser-execution/SKILL.md",
  "utf8"
);

describe("application fill handoff", () => {
  it("sends the worker at the apply URL without a JuiceBox task wrapper", () => {
    expect(rootInstructions).toContain("send the `worker` straight at that URL");
    expect(rootInstructions).toMatch(/no\s+GoForay application task/);
    expect(rootInstructions).toContain("stage_default_goforay_resume");
    expect(rootInstructions).not.toContain("start_goforay_application");
    expect(rootInstructions).not.toContain("report_goforay_application_result");
    expect(rootInstructions).not.toContain("package_pending");

    expect(applicationTools).toContain("findGoforayRoles");
    expect(applicationTools).toContain("nextGoforayRoles");
    expect(applicationTools).not.toContain("createApplicationTask");
    expect(applicationTools).not.toContain("reportApplicationTask");
    expect(applicationTools).not.toContain("start_goforay_application");
    expect(workerInstructions).toContain("stage_default_goforay_resume");
    expect(browserSkill).toContain("stage the default resume");
  });
});
