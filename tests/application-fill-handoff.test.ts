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
    expect(rootInstructions).toContain(
      "send the `worker` straight at that URL"
    );
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

  it("observes third-party ATS pages before scripting Playwright", () => {
    expect(workerInstructions).toContain(
      "Observe then act on third-party ATS pages"
    );
    expect(workerInstructions).toContain(
      "Do not assume Greenhouse, an embedded iframe, or `#resume`"
    );
    expect(workerInstructions).toContain("Never pass a Buffer");
    expect(workerInstructions).toContain("Obey a tool `next_action`");
    expect(browserSkill).toContain(
      "take one masked `computer_action` screenshot only when visual inspection is required"
    );
    expect(browserSkill).toContain(
      "Do not assume Greenhouse, an embedded iframe, or `#resume`"
    );
    expect(browserSkill).toContain("never pass a Buffer");
    expect(browserSkill).toContain(
      "inspect the returned URL and post-action browser state first"
    );
    expect(browserSkill).not.toContain(
      "Prefer Playwright for navigation, inspection, extraction"
    );
  });
});
