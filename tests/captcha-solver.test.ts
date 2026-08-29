import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  captchaSolverCode,
  normalizeCaptchaSolveResult,
} from "../agent/subagents/worker/lib/captcha-solver";
import solveCaptcha from "../agent/subagents/worker/tools/solve_captcha";

const mocks = vi.hoisted(() => ({
  executePlaywright: vi.fn<
    (
      _sessionId: string,
      _input: unknown,
      _options: unknown
    ) => Promise<{
      error?: string;
      result?: unknown;
      success: boolean;
    }>
  >(),
  requireOwnedBrowserSession:
    vi.fn<(_scope: unknown, _sessionId: string) => Promise<unknown>>(),
  requireWorkerScope: vi.fn<(_context: unknown) => Promise<unknown>>(),
}));

vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));

vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      playwright: { execute: mocks.executePlaywright },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    sessionId: "browser-1",
  });
  mocks.executePlaywright.mockResolvedValue({
    result: {
      clicked: { kind: "hcaptcha", x: 42, y: 48 },
      kinds: ["hcaptcha"],
      state: "solved",
      url: "https://jobs.example/apply",
    },
    success: true,
  });
});

describe("checkbox CAPTCHA solver", () => {
  it("clicks with a trusted CDP mouse event instead of a DOM click", () => {
    expect(captchaSolverCode).toContain("Input.dispatchMouseEvent");
    expect(captchaSolverCode).toContain("mousePressed");
    expect(captchaSolverCode).toContain("mouseReleased");
    expect(captchaSolverCode).toContain("context.newCDPSession(page)");
    expect(captchaSolverCode).not.toMatch(
      /locator\([^)]*hcaptcha[^)]*\)\.click/i
    );
    expect(captchaSolverCode).not.toContain("networkidle");
  });

  it("targets hCaptcha, Imperva interstitials, and uncleared Turnstile checkboxes", () => {
    expect(captchaSolverCode).toContain("data-hcaptcha-widget-id");
    expect(captchaSolverCode).toContain("_incapsula_resource");
    expect(captchaSolverCode).toContain("h-captcha-response");
    expect(captchaSolverCode).toContain("hcaptcha_challenge");
    expect(captchaSolverCode).toContain("cf-turnstile");
    expect(captchaSolverCode).not.toContain("2captcha");
    expect(captchaSolverCode).not.toContain("capsolver");
  });

  it("does not attempt image-grid or token-injection solving", () => {
    expect(captchaSolverCode).not.toMatch(/recaptcha-anchor|rc-imageselect/);
    expect(captchaSolverCode).not.toMatch(/innerHTML\s*=/);
    expect(captchaSolverCode).toContain('state: "challenge_required"');
  });

  it("normalizes Kernel Playwright results", () => {
    expect(
      normalizeCaptchaSolveResult({
        result: {
          kinds: ["hcaptcha"],
          state: "already_solved",
          url: "https://jobs.example/apply",
        },
        success: true,
      })
    ).toEqual({
      kinds: ["hcaptcha"],
      state: "already_solved",
      url: "https://jobs.example/apply",
    });
    expect(
      normalizeCaptchaSolveResult({
        error: "timeout",
        success: false,
      })
    ).toEqual({ kinds: [], state: "execution_failed" });
    expect(
      normalizeCaptchaSolveResult({
        result: { state: "nope" },
        success: true,
      })
    ).toEqual({ kinds: [], state: "execution_failed" });
  });

  it("runs the solver against an owned Kernel session", async () => {
    const inputSchema = solveCaptcha.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("solve_captcha must use a Zod input schema.");
    }
    expect(inputSchema.safeParse({}).success).toBe(false);
    expect(inputSchema.safeParse({ session_id: "browser-1" }).success).toBe(
      true
    );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; execute only reads abortSignal after the mocked authorization boundary.
    const result = await solveCaptcha.execute(
      { session_id: "browser-1" },
      {} as never
    );

    expect(mocks.requireOwnedBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1"
    );
    expect(mocks.executePlaywright).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      { code: captchaSolverCode, timeout_sec: 30 },
      { signal: undefined }
    );
    expect(result).toEqual({
      clicked: { kind: "hcaptcha", x: 42, y: 48 },
      kinds: ["hcaptcha"],
      state: "solved",
      url: "https://jobs.example/apply",
    });
  });

  it("teaches the worker to wait for Kernel then call solve_captcha", () => {
    const skill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );
    const instructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );

    expect(skill).toContain("call `solve_captcha` once");
    expect(skill).toContain("trusted CDP mouse event");
    expect(skill).not.toContain("Do not bypass authentication, CAPTCHAs");
    expect(instructions).toContain("`solve_captcha`");
  });
});
