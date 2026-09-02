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
    expect(instructions).toContain(
      "call `continue_application` with that `apply_url` and their answers"
    );
    expect(instructions).toContain('pause: "user_input"');
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

    expect(instructions).toContain('pause: "vault_setup"');
    expect(instructions).toContain("request_vault_setup");
    expect(instructions).toContain("never ask for the password in chat");
    expect(instructions).toContain("never put an identifier");
    expect(instructions).toContain("raw HTTPS setup URL on its own line");
    expect(instructions).toContain(
      "`pause` of `approval`, `user_input`, `vault_setup`, or `email_otp`"
    );
    // A dead posting had no category of its own, so a failed apply against a
    // taken-down role was reported to the candidate as an OTP problem.
    expect(workerInstructions).toContain("Needs posting unavailable:");
    expect(browserSkill).toContain("Needs posting unavailable:");
    expect(instructions).toContain(
      'When the runner returns `{ pause: "posting_unavailable" }`'
    );
    expect(instructions).toContain(
      "Report only the `pause` the runner actually returned"
    );
    expect(workerInstructions).toContain("Needs vault setup:");
    expect(workerInstructions).toContain(
      "Do not use `Needs user input:` for a password"
    );
    expect(browserSkill).toContain("Sign in to apply");
    expect(browserSkill).toContain("Needs vault setup:");
    expect(browserSkill).toContain("visible password rules");
    expect(browserSkill).toContain("provision_login");
    expect(browserSkill).toContain("no registration path");
    // The Kernel session must outlive the turn budget. When it does not, it
    // expires mid-application and every later tool call fails for a reason
    // unrelated to the page.
    expect(instructions).toContain("timeout_seconds` of at least 900");
    expect(workerInstructions).toContain("timeout_seconds` of at least 900");
    expect(browserSkill).toContain("twelve minutes");

    // The candidate reviews every application before it goes out, so all three
    // layers have to agree that the final submit waits for their reply.
    expect(instructions).toContain('pause: "approval"');
    expect(instructions).toContain("never approve on");
    expect(workerInstructions).toContain(
      "Never submit a job application on the first pass"
    );
    expect(workerInstructions).toContain("request_submission_approval");
    expect(browserSkill).toContain("Submission review gate");
    expect(browserSkill).toContain("request_submission_approval");
    expect(workerInstructions).toContain("twelve minutes");
  });

  it("reads email OTP from Gmail instead of asking the candidate", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );
    const otpTool = readFileSync("agent/tools/wait_for_email_otp.ts", "utf8");

    expect(instructions).toContain('pause: "email_otp"');
    expect(instructions).toContain("call `wait_for_email_otp`");
    expect(instructions).toContain("do not print the code to the user");
    expect(instructions).toContain("Never print an email OTP to the user");
    expect(instructions).toContain("including SMS OTP and 3-D Secure");
    expect(workerInstructions).toContain("Needs email OTP:");
    expect(workerInstructions).toContain(
      "Do not use `Needs user input:` for email"
    );
    expect(workerInstructions).toContain(
      "SMS OTP and 3-D Secure still use `Needs user input:`"
    );
    expect(workerInstructions).toContain(
      "`fill_from_vault` cannot fill one-time-code fields"
    );
    expect(browserSkill).toContain("Needs email OTP:");
    expect(browserSkill).toContain("3-D Secure or SMS OTP require human");
    expect(browserSkill).not.toContain("3-D Secure or OTP require human");
    expect(otpTool).toContain("waitForEmailOtp");
    expect(otpTool).not.toContain("redactGoogleText");
  });

  it("asks the candidate for a code instead of surfacing a Connect prompt", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    // An emailed code has to reach `wait_for_email_otp`, the only Google path
    // that degrades instead of letting Eve emit its authorization prompt.
    for (const file of [workerInstructions, browserSkill]) {
      expect(file).toContain(
        "emails a verification code, return `Needs email OTP:`"
      );
      expect(file).not.toContain(
        "verification code or link, return `Needs user input:`"
      );
    }

    // `google_workspace_read` redacts every six-digit code out of its results,
    // so hunting for an OTP there could only ever end in a consent prompt.
    expect(instructions).not.toContain(
      "resolve it from the candidate's inbox with `google_workspace_read`"
    );
    expect(instructions).toContain(
      "Never search for a\none-time code with `google_workspace_read`"
    );
    expect(instructions).toContain("ask them to paste it in the chat");
    expect(instructions).toContain("Never relay an authorization pairing");
    expect(instructions).toContain(
      "Never send the candidate an authorization pairing code or a `connect.vercel.com` URL."
    );
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
    expect(browserSkill).toContain("dedicated Workday router");
    expect(browserSkill).toContain("Read its `workday` result");
    expect(browserSkill).toContain(
      "Treat `route_incomplete` as an automatic recovery state"
    );
    expect(browserSkill).toContain("Do not ask for a takeover");
  });

  it("keeps an ATS resume that is already attached", () => {
    const workerInstructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const browserSkill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );

    expect(browserSkill).toContain("If one exists, keep it and continue");
    expect(browserSkill).toContain("do not retry it");
    expect(workerInstructions).toMatch(
      /Keep an existing resume\s+and continue/
    );
    expect(workerInstructions).toMatch(
      /Do not retry a protected\s+resume upload after\s+a server error/
    );
  });

  it("forbids dumping tool or worker JSON to the user", () => {
    const instructions = readFileSync("agent/instructions.md", "utf8");
    const applicationTools = readFileSync(
      "agent/tools/goforay-applications.ts",
      "utf8"
    );

    expect(instructions).toContain("Never send raw JSON");
    expect(instructions).toContain(
      "Roles from `find_goforay_roles` and `find_next_goforay_roles` are"
    );
    expect(instructions).toContain("dump `cards` or `result`");
    expect(applicationTools).toContain("never paste this object");
  });
});
