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
    expect(instructions).toContain("never put an identifier");
    expect(instructions).toContain("raw HTTPS setup URL on its own line");
    expect(instructions).toContain(
      "structured `Needs user input:` or `Needs vault setup:` failure"
    );
    expect(workerInstructions).toContain("Needs vault setup:");
    expect(workerInstructions).toContain(
      "Do not use `Needs user input:` for a password"
    );
    expect(browserSkill).toContain("Sign in to apply");
    expect(browserSkill).toContain("Needs vault setup:");
    expect(browserSkill).toContain("visible password rules");
  });

  it("submits a completed ATS login without inspecting injected credentials", () => {
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(browserSkill).toContain(
      "Immediately after a successful login fill, activate that pre-identified form control once"
    );
    expect(browserSkill).toContain(
      "After the final credential fill, always activate the observed form-bound sign-in control"
    );
    expect(browserSkill).toContain("do not inspect filled values");
  });

  it("uses the Workday email path and avoids page-level sign-in bubbles", () => {
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(browserSkill).toContain("Sign in with email");
    expect(browserSkill).toContain(
      "dismiss it with its observed close (`X`) control"
    );
    expect(browserSkill).toContain("Never fill into or submit a global header");
    expect(browserSkill).toContain("form-bound sign-in control");
    expect(browserSkill).toContain(
      "a centered Intapp modal that offers Google, LinkedIn, and `Sign in with email`"
    );
    expect(browserSkill).toContain("never close that modal with its `X`");
    expect(browserSkill).toContain(
      "Ignore any `click to take control` overlay"
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
