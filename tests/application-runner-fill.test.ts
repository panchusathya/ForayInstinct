import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCandidateProfile } from "@/lib/candidate-profile";

interface PlaywrightRequest {
  code: string;
}

const mocks = vi.hoisted(() => ({
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _request: PlaywrightRequest
      ) => Promise<{ result?: unknown; success: boolean }>
    >(),
  generateText:
    vi.fn<(_input: { prompt: string }) => Promise<{ text: string }>>(),
  inspect: vi.fn<() => Promise<Record<string, unknown>>>(),
  profile: vi.fn<() => Promise<unknown>>(),
  identity: vi.fn<() => Promise<unknown>>(),
  resume: vi.fn<() => Promise<undefined>>(),
  vault: vi.fn<() => Promise<{ filled: boolean; origin: string }>>(),
  checkpoint: vi.fn<() => Promise<void>>(),
  stageFile: vi.fn<() => Promise<void>>(),
  updateApplicationRun: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/model-config", () => ({
  chatLanguageModel: "test-model",
}));

vi.mock("@/lib/browser", () => ({
  browserProvider: {
    executePlaywright: mocks.executePlaywright,
    stageFile: mocks.stageFile,
  },
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

vi.mock("@/agent/subagents/worker/lib/post-action-browser-state", () => ({
  inspectPostActionBrowserState: mocks.inspect,
}));

vi.mock("@/db/services/candidate-profile", () => ({
  readCandidateProfile: mocks.profile,
  readCandidateContactIdentity: mocks.identity,
}));

vi.mock("@/db/services/default-resume", () => ({
  readOrImportDefaultResume: mocks.resume,
}));

vi.mock("@/lib/application-runner/vault", () => ({
  tryFillLoginFromVault: mocks.vault,
}));

vi.mock("@/db/services/browser-run-checkpoints", () => ({
  recordBrowserRunCheckpoint: mocks.checkpoint,
}));

vi.mock("@/db/services/application-executions", () => ({
  updateApplicationRun: mocks.updateApplicationRun,
}));

import { fillVisibleForm } from "@/lib/application-runner/fill";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue({});
  mocks.vault.mockResolvedValue({
    filled: false,
    origin: "https://jobs.example",
  });
  mocks.profile.mockResolvedValue({
    ...emptyCandidateProfile,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
  });
  mocks.identity.mockResolvedValue({
    email: "ada@example.com",
    name: "Ada Lovelace",
    phone: "",
  });
  mocks.resume.mockResolvedValue(undefined);
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.stageFile.mockResolvedValue(undefined);
  mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
    if (request.code.includes("loginWall")) {
      return { success: true, result: { loginWall: false } };
    }
    if (request.code.includes("input, textarea, select")) {
      return {
        result: {
          fields: [
            {
              label: "Email",
              name: "email",
              required: true,
              selector: "#email",
              tag: "input",
              type: "email",
            },
            {
              label: "Favorite color",
              name: "color",
              required: true,
              selector: "#color",
              tag: "input",
              type: "text",
            },
          ],
        },
        success: true,
      };
    }
    return { result: { filled: ["#email"] }, success: true };
  });
  mocks.generateText.mockResolvedValue({
    text: JSON.stringify({
      fills: [{ selector: "#color", value: "blue" }],
    }),
  });
});

describe("application runner fill", () => {
  it("fills mapped fields then asks the bounded LLM helper for leftovers", async () => {
    const result = await fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });
    expect(result).toEqual({ continue: true });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("Favorite color");
    expect(prompt).not.toContain("screenshot");
    const codes = mocks.executePlaywright.mock.calls.map(
      (call) => call[1].code
    );
    expect(codes.some((code) => code.includes("#email"))).toBe(true);
    expect(codes.some((code) => code.includes("#color"))).toBe(true);
    expect(codes.join("\n")).not.toContain("computer_action");
  });

  it("returns a structured email_otp pause from the DOM probe", async () => {
    mocks.inspect.mockResolvedValue({
      emailOtp: true,
      otpHint: "Greenhouse",
    });
    const result = await fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });
    expect(result).toMatchObject({
      applyUrl: "https://jobs.example/role/1",
      pause: "email_otp",
    });
    expect(result).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^Needs email OTP:/u),
      })
    );
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
