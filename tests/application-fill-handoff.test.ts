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
  it("starts the browser worker without waiting on JuiceBox packaging", () => {
    expect(rootInstructions).toContain("immediately delegate the browser");
    expect(rootInstructions).toContain("not a start gate");
    expect(rootInstructions).toContain("stage_default_goforay_resume");
    expect(rootInstructions).not.toContain("delegate only when it is `ready`");
    expect(rootInstructions).not.toContain("Read the same task again before");

    expect(applicationTools).toContain("do not wait for package_pending");
    expect(applicationTools).toContain("Never poll this as a start gate");
  });

  it("keeps JuiceBox as CRM context while the worker fills the ATS itself", () => {
    expect(rootInstructions).toContain("start_goforay_application");
    expect(rootInstructions).toContain("report_goforay_application_result");
    expect(applicationTools).toContain("createApplicationTask");
    expect(applicationTools).toContain("reportApplicationTask");
    expect(workerInstructions).toMatch(/Do not wait for JuiceBox\s+packaging/);
    expect(workerInstructions).toContain("stage_default_goforay_resume");
    expect(workerInstructions).toContain("stage_goforay_document");
    expect(browserSkill).toContain("do not wait for JuiceBox packaging");
    expect(browserSkill).toContain("stage_default_goforay_resume");
  });
});
