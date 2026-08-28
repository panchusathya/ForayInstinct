import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("worker input bubbling", () => {
  it("keeps native questions disabled", () => {
    const askQuestionTool = readFileSync("agent/tools/ask_question.ts", "utf8");

    expect(askQuestionTool).toMatch(/disableTool\(\)/);
  });

  it("ends the worker turn and routes the answer through its agent id", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(instructions).toContain(
      "Ask the user directly in ordinary assistant text"
    );
    expect(instructions).toContain("continue that worker with its `agentId`");
    expect(instructions).toContain("returns a `Needs user input:` blocker");
    expect(browserSkill).toContain("native `final_output` with `failure`");
    expect(browserSkill).toContain("End the turn immediately");
  });

  it("turns a missing ATS login into vault setup instead of a chat password prompt", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(instructions).toContain("returns a `Needs vault setup:` blocker");
    expect(instructions).toContain("request_vault_setup");
    expect(instructions).toContain("never ask for the password in chat");
    expect(instructions).toContain(
      "structured `Needs user input:` or `Needs vault setup:` failure"
    );
    expect(workerInstructions).toContain("Needs vault setup:");
    expect(workerInstructions).toContain(
      "Do not use `Needs user input:` for a password or other secret"
    );
    expect(browserSkill).toContain("Sign in to apply");
    expect(browserSkill).toContain("Needs vault setup:");
    expect(browserSkill).toContain(
      "not for passwords or other secrets"
    );
  });

  it("forbids dumping tool or worker JSON to the user", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const applicationTools = readFileSync(
      "agent/tools/goforay-applications.ts",
      "utf8"
    );

    expect(instructions).toContain("Never send raw JSON");
    expect(instructions).toContain("one bullet per role");
    expect(instructions).toContain(
      "dump `documents`, `form_answers`, `cards`, or `result`"
    );
    expect(applicationTools).toContain("never paste this object");
    expect(applicationTools).toContain(
      "Do not dump documents, form_answers, or this object to the user"
    );
  });
});
