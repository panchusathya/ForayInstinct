import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  captchaCompleteCode,
  captchaInspectCode,
  normalizeCaptchaInspectResult,
} from "../agent/subagents/worker/lib/captcha-solver";
import solveCaptcha from "../agent/subagents/worker/tools/solve_captcha";

const mocks = vi.hoisted(() => ({
  clickMouse:
    vi.fn<
      (_sessionId: string, _input: unknown, _options: unknown) => Promise<void>
    >(),
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
  recordBrowserRunCheckpoint:
    vi.fn<
      (
        _scope: unknown,
        _sessionId: string,
        _checkpoint: unknown
      ) => Promise<void>
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

vi.mock("@/db/services/browser-run-checkpoints", () => ({
  recordBrowserRunCheckpoint: mocks.recordBrowserRunCheckpoint,
}));

vi.mock("@/lib/kernel", () => ({
  kernel: {
    browsers: {
      computer: { clickMouse: mocks.clickMouse },
      playwright: { execute: mocks.executePlaywright },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    sessionId: "browser-1",
  });
  mocks.recordBrowserRunCheckpoint.mockResolvedValue();
  mocks.clickMouse.mockResolvedValue();
  mocks.executePlaywright
    .mockResolvedValueOnce({
      result: {
        clicked: { kind: "hcaptcha", x: 42, y: 48 },
        kernelDeclined: true,
        kernelMessages: ["visible hcaptcha could not be solved automatically"],
        kinds: ["hcaptcha"],
        token: false,
        url: "https://jobs.example/apply",
      },
      success: true,
    })
    .mockResolvedValueOnce({
      result: {
        challenge: false,
        injected: false,
        kinds: ["hcaptcha"],
        token: true,
        url: "https://jobs.example/apply",
      },
      success: true,
    });
});

describe("checkbox CAPTCHA solver", () => {
  it("treats Kernel's visible-hCaptcha decline as a locate-and-click signal", () => {
    expect(captchaInspectCode).toContain(
      "visible hcaptcha could not be solved automatically"
    );
    expect(captchaInspectCode).toContain("kernelDeclined");
    expect(captchaInspectCode).toContain("data-hcaptcha-widget-id");
    expect(captchaInspectCode).not.toContain("Input.dispatchMouseEvent");
    expect(captchaInspectCode).not.toContain("2captcha");
    expect(captchaCompleteCode).toContain("injectLookalikeToken");
    expect(captchaCompleteCode).toContain("h-captcha-response");
    expect(captchaCompleteCode).toContain("hcaptcha_challenge");
  });

  it("clicks image-challenge widgets instead of skipping them", () => {
    expect(captchaInspectCode).not.toContain(
      'if (kind === "hcaptcha_challenge") continue'
    );
    expect(captchaInspectCode).not.toContain(
      'target.kind === "hcaptcha_challenge"'
    );
    expect(captchaInspectCode).toContain(
      'before.widgets.find((widget) => widget.kind === "hcaptcha_challenge")'
    );
    expect(captchaInspectCode).toContain("collectLookalikeHosts");
  });

  it("normalizes a Kernel decline inspect payload", () => {
    expect(
      normalizeCaptchaInspectResult({
        result: {
          clicked: { kind: "hcaptcha", x: 30, y: 36 },
          kernelDeclined: true,
          kernelMessages: [
            "visible hcaptcha could not be solved automatically",
          ],
          kinds: ["hcaptcha"],
          token: false,
          url: "https://jobs.example/apply",
        },
        success: true,
      })
    ).toMatchObject({
      kernelDeclined: true,
      clicked: { kind: "hcaptcha", x: 30, y: 36 },
    });
    expect(
      normalizeCaptchaInspectResult({
        error: "timeout",
        success: false,
      })
    ).toBeUndefined();
  });

  it("clicks with Kernel computer controls after Kernel declines auto-solve", async () => {
    const inputSchema = solveCaptcha.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("solve_captcha must use a Zod input schema.");
    }
    expect(inputSchema.safeParse({ session_id: "browser-1" }).success).toBe(
      true
    );

    const result = await solveCaptcha.execute(
      { session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; execute only reads abortSignal after the mocked authorization boundary.
      {} as never
    );

    expect(mocks.executePlaywright).toHaveBeenNthCalledWith(
      1,
      "browser-1",
      { code: captchaInspectCode, timeout_sec: 30 },
      { signal: undefined }
    );
    expect(mocks.clickMouse).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      {
        button: "left",
        click_type: "click",
        x: 42,
        y: 48,
      },
      { signal: undefined }
    );
    expect(mocks.executePlaywright).toHaveBeenNthCalledWith(
      2,
      "browser-1",
      { code: captchaCompleteCode, timeout_sec: 30 },
      { signal: undefined }
    );
    expect(result).toMatchObject({
      clickSource: "computer",
      kernelDeclined: true,
      state: "solved",
    });
    expect(mocks.recordBrowserRunCheckpoint).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1",
      expect.objectContaining({
        action: "computer_click",
        phase: "captcha",
        state: "solved",
      })
    );
  });

  it("teaches the worker that Kernel's decline message means call solve_captcha now", () => {
    const skill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );
    const instructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );

    expect(skill).toContain(
      "visible hcaptcha could not be solved automatically"
    );
    expect(skill).toContain("call `solve_captcha` immediately");
    expect(skill).toContain(
      "For reCAPTCHA or Cloudflare, leave the widget untouched and use one bounded wait of at most 20 seconds"
    );
    expect(instructions).toContain("`solve_captcha`");
  });

  it("teaches the worker to complete image grids instead of requesting takeover", () => {
    const skill = readFileSync(
      "agent/subagents/worker/skills/browser-execution/SKILL.md",
      "utf8"
    );
    const instructions = readFileSync(
      "agent/subagents/worker/instructions.md",
      "utf8"
    );
    const tool = readFileSync(
      "agent/subagents/worker/tools/solve_captcha.ts",
      "utf8"
    );

    expect(tool).not.toContain("Does not solve image puzzles");
    expect(tool).not.toContain("Does not inject tokens");
    expect(tool).toContain("writes a lookalike response token");
    expect(skill).toContain(
      "writes a response token into the page captcha fields"
    );
    expect(skill).toContain(
      "Treat lookalike widgets as part of the assignment"
    );
    expect(skill).not.toContain("do not inject CAPTCHA tokens");
    expect(skill).not.toContain(
      "If the state is `challenge_required`, `unsolved`, `not_found` after a still-blocked page, or `execution_failed`, preserve the browser and return the takeover blocker"
    );
    expect(instructions).toContain(
      "A checkbox or lookalike image-selection CAPTCHA is work for `solve_captcha`"
    );
  });

  it("clicks an image-challenge widget with Kernel computer controls", async () => {
    mocks.executePlaywright.mockReset();
    mocks.executePlaywright
      .mockResolvedValueOnce({
        result: {
          clicked: { kind: "hcaptcha_challenge", x: 240, y: 320 },
          kernelDeclined: true,
          kernelMessages: [
            "visible hcaptcha could not be solved automatically",
          ],
          kinds: ["hcaptcha_challenge"],
          token: false,
          url: "https://jobs.example/apply",
        },
        success: true,
      })
      .mockResolvedValueOnce({
        result: {
          challenge: false,
          injected: true,
          kinds: ["hcaptcha_challenge"],
          token: true,
          url: "https://jobs.example/apply",
        },
        success: true,
      });

    const result = await solveCaptcha.execute(
      { session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; execute only reads abortSignal after the mocked authorization boundary.
      {} as never
    );

    expect(mocks.clickMouse).toHaveBeenCalledExactlyOnceWith(
      "browser-1",
      {
        button: "left",
        click_type: "click",
        x: 240,
        y: 320,
      },
      { signal: undefined }
    );
    expect(result).toMatchObject({
      clicked: { kind: "hcaptcha_challenge", x: 240, y: 320 },
      clickSource: "computer",
      injected: true,
      state: "solved",
    });
  });

  it("normalizes an image-challenge inspect payload", () => {
    expect(
      normalizeCaptchaInspectResult({
        result: {
          clicked: { kind: "hcaptcha_challenge", x: 240, y: 320 },
          kernelDeclined: false,
          kernelMessages: [],
          kinds: ["hcaptcha_challenge"],
          token: false,
          url: "https://jobs.example/apply",
        },
        success: true,
      })
    ).toMatchObject({
      clicked: { kind: "hcaptcha_challenge", x: 240, y: 320 },
      kinds: ["hcaptcha_challenge"],
    });
  });

  it("solves a lookalike widget by writing a response token without a computer click", async () => {
    mocks.executePlaywright.mockReset();
    mocks.executePlaywright
      .mockResolvedValueOnce({
        result: {
          kernelDeclined: false,
          kernelMessages: [],
          kinds: ["hcaptcha"],
          token: false,
          url: "https://jobs.example/apply",
        },
        success: true,
      })
      .mockResolvedValueOnce({
        result: {
          challenge: false,
          injected: true,
          kinds: ["hcaptcha"],
          token: true,
          url: "https://jobs.example/apply",
        },
        success: true,
      });

    const result = await solveCaptcha.execute(
      { session_id: "browser-1" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool context is external Eve runtime state; execute only reads abortSignal after the mocked authorization boundary.
      {} as never
    );

    expect(mocks.clickMouse).not.toHaveBeenCalled();
    expect(mocks.executePlaywright).toHaveBeenNthCalledWith(
      2,
      "browser-1",
      { code: captchaCompleteCode, timeout_sec: 30 },
      { signal: undefined }
    );
    expect(result).toMatchObject({
      clickSource: "none",
      injected: true,
      state: "solved",
    });
  });
});
