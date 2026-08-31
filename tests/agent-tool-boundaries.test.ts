import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserGatewayModel, chatGatewayModel } from "@/lib/model-config";

const rootTools = "agent/tools";
const workerRoot = "agent/subagents/worker";
const workerTools = `${workerRoot}/tools`;

function toolFiles(directory: string) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts"))
    .toSorted();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [path]
      : [];
  });
}

describe("root and worker capability boundaries", () => {
  it("pins chat and browser work to GLM 5.3 Flash on AI Gateway", () => {
    const rootAgent = readFileSync("agent/agent.ts", "utf8");
    const workerAgent = readFileSync(`${workerRoot}/agent.ts`, "utf8");
    const models = readFileSync("lib/model-config.ts", "utf8");

    expect(chatGatewayModel).toBe("zai/glm-5.3-flash");
    expect(browserGatewayModel).toBe("zai/glm-5.3-flash");
    expect(models).toContain(`chatGatewayModel = "${chatGatewayModel}"`);
    expect(models).toContain(`browserGatewayModel = "${browserGatewayModel}"`);
    expect(rootAgent).toContain("model: chatGatewayModel");
    expect(workerAgent).toContain("model: browserGatewayModel");
    expect(readFileSync("lib/manager/server/store.ts", "utf8")).toContain(
      "inference: chatGatewayModel"
    );
    expect(rootAgent).not.toContain("defineDynamic(");
    expect(workerAgent).not.toContain("defineDynamic(");

    const leftoverOpenAi = /openai\/|terra-fast|luna-fast|sol-fast|gpt-5\.6/;
    for (const file of [
      "lib/model-config.ts",
      "lib/manager/server/store.ts",
      "agent/agent.ts",
      `${workerRoot}/agent.ts`,
      ...sourceFiles("agent"),
      ...sourceFiles("lib"),
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(leftoverOpenAi);
    }
  });

  it("keeps root coordination separate from browser execution", () => {
    expect(toolFiles(rootTools)).toEqual([
      "agent.ts",
      "ask_question.ts",
      "browser_run_checkpoints.ts",
      "candidate_documents.ts",
      "candidate_profile.ts",
      "goforay-applications.ts",
      "google_workspace_read.ts",
      "google_workspace_write.ts",
      "request_vault_setup.ts",
      "self_identification.ts",
      "wait_for_email_otp.ts",
      "web_search.ts",
    ]);
    expect(existsSync(`${rootTools}/sendMessage.ts`)).toBe(false);
    expect(existsSync("agent/extensions/kernel/extension.ts")).toBe(false);
    expect(existsSync("agent/extensions/kernel/connections/browser.ts")).toBe(
      false
    );
    expect(existsSync("agent/skills/browser-execution/SKILL.md")).toBe(false);
    expect(readFileSync(`${rootTools}/agent.ts`, "utf8")).toContain(
      "disableTool()"
    );
    expect(readFileSync(`${rootTools}/ask_question.ts`, "utf8")).toContain(
      "disableTool()"
    );
  });

  it("gives worker the browser and opaque-vault tools without messaging", () => {
    expect(toolFiles(workerTools)).toEqual([
      "ask_question.ts",
      "computer_action.ts",
      "execute_playwright_code.ts",
      "fill_from_vault.ts",
      "list_vault.ts",
      "manage_browsers.ts",
      "provision_login.ts",
      "request_submission_approval.ts",
      "solve_captcha.ts",
      "stage_default_goforay_resume.ts",
      "stage_goforay_document.ts",
      "stage_workspace_document.ts",
    ]);
    expect(existsSync(`${workerRoot}/tools/sendMessage.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/tools/request_vault_setup.ts`)).toBe(
      false
    );
    expect(readFileSync(`${workerTools}/ask_question.ts`, "utf8")).toContain(
      "disableTool()"
    );
    expect(existsSync(`${workerRoot}/extensions/kernel/extension.ts`)).toBe(
      false
    );
    expect(readFileSync("package.json", "utf8")).not.toContain(
      "@onkernel/eve-extension"
    );
    for (const tool of [
      "computer_action",
      "execute_playwright_code",
      "fill_from_vault",
      "manage_browsers",
      "provision_login",
      "request_submission_approval",
      "solve_captcha",
    ]) {
      const source = readFileSync(`${workerTools}/${tool}.ts`, "utf8");
      expect(source).toContain("defineTool(");
      expect(source).not.toContain("defineDynamic(");
      expect(source).toContain("requireWorkerScope(context)");
      expect(source).toContain("requireOwnedBrowserSession");
    }
    // The review gate must not be able to submit the application it captures.
    expect(
      readFileSync(`${workerTools}/request_submission_approval.ts`, "utf8")
    ).not.toMatch(/computer\.|\.click\(|playwright\.execute/);
    expect(existsSync(`${workerRoot}/hooks/session-owner.ts`)).toBe(true);
    expect(existsSync(`${workerRoot}/skills/browser-execution/SKILL.md`)).toBe(
      true
    );
    expect(readFileSync(`${workerRoot}/instructions.md`, "utf8")).not.toContain(
      "`inspect_autofill`"
    );
    expect(readFileSync(`${workerRoot}/instructions.md`, "utf8")).toContain(
      "native `final_output` tool exactly once"
    );
    expect(existsSync(`${workerRoot}/lib/browser-contract.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/lib/browser-runtime.ts`)).toBe(false);
    expect(existsSync(`${workerRoot}/lib/owned-browser.ts`)).toBe(true);

    expect(readFileSync("lib/kernel.ts", "utf8")).toContain("new Kernel(");
    for (const tool of [
      "computer_action",
      "execute_playwright_code",
      "manage_browsers",
      "solve_captcha",
    ]) {
      const source = readFileSync(`${workerTools}/${tool}.ts`, "utf8");
      expect(source).toContain('from "@/lib/kernel"');
      expect(source).not.toContain("new Kernel(");
    }
    expect(readFileSync(`${workerTools}/fill_from_vault.ts`, "utf8")).toContain(
      'from "@/lib/manager/server/kernel-native-autofill"'
    );
    expect(readFileSync(`${workerTools}/list_vault.ts`, "utf8")).toContain(
      "requireWorkerScope(ctx)"
    );
    expect(readFileSync(`${workerTools}/provision_login.ts`, "utf8")).toContain(
      "Username registration is not supported"
    );
  });

  it("requires structured completion without a parent-supplied outputSchema", () => {
    const rootInstructions = readFileSync("agent/instructions.md", "utf8");
    const workerConfig = readFileSync(`${workerRoot}/agent.ts`, "utf8");
    const workerInstructions = readFileSync(
      `${workerRoot}/instructions.md`,
      "utf8"
    );

    expect(rootInstructions).toContain(
      "Do not pass `outputSchema` on `worker` calls"
    );
    expect(rootInstructions).toContain("do not retry the same handoff");
    expect(rootInstructions).toContain("list_browser_run_checkpoints");
    expect(rootInstructions).toContain("submission_observed");
    expect(rootInstructions).toContain("never spawn a fresh worker");
    expect(rootInstructions).toContain("role title and `apply_url`");
    expect(rootInstructions).not.toContain(
      "Every initial or resumed `worker` call must set `outputSchema`"
    );
    expect(rootInstructions).not.toContain('"additionalProperties": false');
    expect(workerConfig).toContain("outputSchema: taskCompletionSchema");
    expect(workerConfig).toContain(
      "The parent must not pass a per-call outputSchema"
    );
    expect(workerInstructions).toContain(
      "Put every acknowledgement, question, approval request"
    );
    expect(workerInstructions).toContain(
      "native `final_output` tool exactly once"
    );
  });
});
