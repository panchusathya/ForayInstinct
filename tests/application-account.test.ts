import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  click:
    vi.fn<
      (
        _sessionId: string,
        _control: Record<string, unknown>
      ) => Promise<Record<string, unknown>>
    >(),
  createLogin:
    vi.fn<
      (
        _scope: unknown,
        _input: { label: string; secret: string }
      ) => Promise<Record<string, unknown>>
    >(),
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _request: { code: string }
      ) => Promise<{ error?: string; result?: unknown; success: boolean }>
    >(),
  identity: vi.fn<() => Promise<Record<string, unknown>>>(),
  log: vi.fn<(_entry: Record<string, unknown>) => void>(),
  vaultFill: vi.fn<() => Promise<{ filled: boolean; origin: string }>>(),
  vaultItems: vi.fn<() => Promise<{ hasSecret: boolean; kind: string }[]>>(),
}));

vi.mock("@/lib/application-execution", () => ({
  applicationExecutionLog: mocks.log,
}));
vi.mock("@/lib/application-runner/navigate", () => ({
  clickControl: mocks.click,
}));
vi.mock("@/lib/application-runner/vault", () => ({
  tryFillLoginFromVault: mocks.vaultFill,
}));
vi.mock("@/lib/browser", () => ({
  browserProvider: { executePlaywright: mocks.executePlaywright },
}));
vi.mock("@/lib/manager/server/store", () => ({
  createVaultLogin: mocks.createLogin,
}));
vi.mock("@/lib/manager/server/vault", () => ({
  readManagerVaultItems: mocks.vaultItems,
}));
vi.mock("@/db/services/candidate-profile", () => ({
  readCandidateContactIdentity: mocks.identity,
}));

import {
  type LoginWall,
  passLoginWall,
  passwordPolicyFrom,
} from "@/lib/application-runner/account";

const input = {
  applyUrl:
    "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Analyst_R1/apply",
  browserSessionId: "browser-1",
  executionId: "exec-1",
  scope: { userId: "alice", workspaceId: "workspace:alice" },
};

const registerWall: LoginWall = {
  consents: ["#agree"],
  createControl: { index: 5, text: "Create Account" },
  href: "https://acme.wd5.myworkdayjobs.com/en-US/careers/login?redirect=apply",
  identifier: { kind: "email", selector: "#email" },
  loginWall: true,
  passwords: ["#password", "#verifyPassword"],
  policyText:
    "Password must be at least 8 characters and contain at least one special character.",
  signInControl: { index: 7, text: "Sign In" },
  wall: "register",
};

const signInWall: LoginWall = {
  consents: [],
  createControl: { index: 6, text: "Create Account" },
  href: "https://acme.wd5.myworkdayjobs.com/en-US/careers/login",
  identifier: { kind: "email", selector: "#email" },
  loginWall: true,
  passwords: ["#password"],
  policyText: "",
  signInControl: { index: 4, text: "Sign In" },
  wall: "sign_in",
};

const clicked = (heading: string) => ({
  clicked: true,
  errors: [],
  heading,
  href: input.applyUrl,
  navigated: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({
    email: "ada@example.com",
    name: "Ada Lovelace",
    phone: "+14155550100",
  });
  mocks.vaultItems.mockResolvedValue([]);
  mocks.vaultFill.mockResolvedValue({ filled: false, origin: "" });
  mocks.createLogin.mockResolvedValue({
    account: "",
    id: "vault-1",
    label: "",
  });
  mocks.click.mockResolvedValue(clicked("My Information"));
  mocks.executePlaywright.mockResolvedValue({
    result: {
      filled: ["#email", "#password", "#verifyPassword", "#agree"],
      offered: [],
      skipped: [],
    },
    success: true,
  });
});

describe("a registration page", () => {
  it("saves a login to the page's rules before typing, fills it, and presses Create Account", async () => {
    const result = await passLoginWall({ ...input, wall: registerWall });
    expect(result).toEqual({ passed: true, via: "created" });
    // Vault first, page second.
    const saved = mocks.createLogin.mock.invocationCallOrder[0] ?? 0;
    const typed = mocks.executePlaywright.mock.invocationCallOrder[0] ?? 0;
    expect(saved).toBeLessThan(typed);
    const secret = z
      .object({
        authentication: z.object({ password: z.string() }),
        identifier: z.object({ type: z.string(), value: z.string() }),
        origin: z.string(),
      })
      .parse(JSON.parse(mocks.createLogin.mock.calls[0]?.[1]?.secret ?? "{}"));
    expect(secret.origin).toBe("https://acme.wd5.myworkdayjobs.com");
    expect(secret.identifier).toEqual({
      type: "email",
      value: "ada@example.com",
    });
    const password = secret.authentication.password;
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(/[!@#$%^&*\-_=+]/u.test(password)).toBe(true);
    // Both password boxes take the same generated value, the consent is
    // ticked, and the email goes where the page asked for it.
    const code = mocks.executePlaywright.mock.calls[0]?.[1]?.code ?? "";
    expect(code).toContain(`"selector":"#email","value":"ada@example.com"`);
    expect(code).toContain(
      `"selector":"#password","value":${JSON.stringify(password)}`
    );
    expect(code).toContain(
      `"selector":"#verifyPassword","value":${JSON.stringify(password)}`
    );
    expect(code).toContain(`"selector":"#agree","value":"yes"`);
    expect(mocks.click).toHaveBeenCalledWith("browser-1", {
      disabled: false,
      href: "",
      index: 5,
      text: "Create Account",
    });
    // The password reaches the vault and the page, and nothing else.
    for (const entry of mocks.log.mock.calls.map((call) => call[0])) {
      expect(JSON.stringify(entry)).not.toContain(password);
    }
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        control: "Create Account",
        event: "runner.account_created",
        origin: "https://acme.wd5.myworkdayjobs.com",
      })
    );
  });

  it("signs in instead when a login for the site is already saved", async () => {
    mocks.vaultItems.mockResolvedValue([{ hasSecret: true, kind: "login" }]);
    mocks.executePlaywright.mockResolvedValue({
      result: { ...signInWall, createControl: null },
      success: true,
    });
    mocks.vaultFill.mockResolvedValue({
      filled: true,
      origin: "https://acme.wd5.myworkdayjobs.com",
    });
    const result = await passLoginWall({ ...input, wall: registerWall });
    expect(result).toEqual({ passed: true, via: "sign_in" });
    expect(mocks.createLogin).not.toHaveBeenCalled();
    // Sign In link opened, then the sign-in page's own Sign In button.
    expect(mocks.click.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: "Sign In", index: 7 }),
      expect.objectContaining({ text: "Sign In", index: 4 }),
    ]);
  });

  it("asks for vault setup when the candidate has no verified email to register with", async () => {
    mocks.identity.mockResolvedValue({ name: "Ada Lovelace" });
    const result = await passLoginWall({ ...input, wall: registerWall });
    expect(result).toMatchObject({ pause: "vault_setup" });
    expect("message" in result ? result.message : "").toContain(
      "no verified email address to register with"
    );
    expect(mocks.createLogin).not.toHaveBeenCalled();
    expect(mocks.executePlaywright).not.toHaveBeenCalled();
  });

  it("stops with the page's words when the account is refused", async () => {
    mocks.click.mockResolvedValue({
      clicked: true,
      errors: ["An account with this email already exists."],
      heading: "Create Account",
      href: registerWall.href,
      navigated: false,
    });
    const result = await passLoginWall({ ...input, wall: registerWall });
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "An account with this email already exists."
    );
  });
});

describe("a sign-in page", () => {
  it("fills a saved login and presses Sign In", async () => {
    mocks.vaultFill.mockResolvedValue({
      filled: true,
      origin: "https://acme.wd5.myworkdayjobs.com",
    });
    const result = await passLoginWall({ ...input, wall: signInWall });
    expect(result).toEqual({ passed: true, via: "sign_in" });
    expect(mocks.click).toHaveBeenCalledWith(
      "browser-1",
      expect.objectContaining({ index: 4, text: "Sign In" })
    );
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runner.signed_in" })
    );
  });

  it("opens Create Account and registers when nothing is saved", async () => {
    mocks.executePlaywright
      .mockResolvedValueOnce({ result: registerWall, success: true })
      .mockResolvedValueOnce({
        result: {
          filled: ["#email", "#password", "#verifyPassword", "#agree"],
          skipped: [],
        },
        success: true,
      });
    const result = await passLoginWall({ ...input, wall: signInWall });
    expect(result).toEqual({ passed: true, via: "created" });
    expect(mocks.click.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ index: 6, text: "Create Account" })
    );
    expect(mocks.createLogin).toHaveBeenCalledTimes(1);
  });

  it("asks for vault setup when nothing is saved and the page offers no registration", async () => {
    const result = await passLoginWall({
      ...input,
      wall: { ...signInWall, createControl: null },
    });
    expect(result).toMatchObject({ pause: "vault_setup" });
    expect("message" in result ? result.message : "").toContain(
      "offers no way to create an account"
    );
  });
});

describe("reading a page's password rules", () => {
  it("takes the length and symbol demands and leaves the rest to the defaults", () => {
    expect(
      passwordPolicyFrom(
        "Your password must be between 10 and 30 characters and include a special character."
      )
    ).toEqual({ maxLength: 30, minLength: 10, requireSymbol: true });
    expect(passwordPolicyFrom("Use at least 12 characters.")).toEqual({
      minLength: 12,
    });
    expect(passwordPolicyFrom("")).toEqual({});
  });

  it("is read by a probe that reports selectors and control text, never values", () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const probe = scripts.slice(
      scripts.indexOf("export const detectLoginWallCode"),
      scripts.indexOf("export const clickSubmitCode")
    );
    expect(probe).toContain("passwords.length >= 2");
    expect(probe).toContain('"${pageControlsLocator}"');
    expect(probe).not.toMatch(/\.value\b(?!\s*\|\|)/u);
  });
});
