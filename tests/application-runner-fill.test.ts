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
  resume: vi.fn<() => Promise<unknown>>(),
  vault: vi.fn<() => Promise<{ filled: boolean; origin: string }>>(),
  checkpoint: vi.fn<() => Promise<void>>(),
  stageFile:
    vi.fn<
      (
        _sessionId: string,
        _file: { bytes: Uint8Array; path: string }
      ) => Promise<void>
    >(),
  updateApplicationRun: vi.fn<() => Promise<void>>(),
  saveCandidateProfile: vi.fn<() => Promise<{ stored: boolean }>>(),
  selfIdentification: vi.fn<() => Promise<Record<string, string>>>(),
  providerName: ((): { value: "gateway" | "kernel" } => ({
    value: "gateway",
  }))(),
  readAnswers: vi.fn<() => Promise<Record<string, string>>>(),
  rememberAnswers: vi.fn<() => Promise<void>>(),
  forgetAnswers: vi.fn<() => Promise<void>>(),
  rememberPhone: vi.fn<(_scope: unknown, _value: string) => Promise<void>>(),
}));

vi.mock("@/lib/manager/server/application-answers", () => ({
  forgetRunAnswers: mocks.forgetAnswers,
  readRunAnswers: mocks.readAnswers,
  rememberRunAnswers: mocks.rememberAnswers,
}));

vi.mock("@/lib/manager/server/contact-phone", () => ({
  rememberContactPhone: mocks.rememberPhone,
}));

vi.mock("@/lib/model-config", () => ({
  chatLanguageModel: "test-model",
}));

vi.mock("@/lib/browser", () => ({
  browserProvider: {
    executePlaywright: mocks.executePlaywright,
    get name() {
      return mocks.providerName.value;
    },
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
  saveCandidateProfile: mocks.saveCandidateProfile,
}));

vi.mock("@/db/services/default-resume", () => ({
  readOrImportDefaultResume: mocks.resume,
}));

vi.mock("@/db/services/self-identification", () => ({
  readSelfIdentification: mocks.selfIdentification,
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

import {
  enterVerificationCode,
  fillVisibleForm,
  submitApplication,
} from "@/lib/application-runner/fill";

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
  mocks.selfIdentification.mockResolvedValue({});
  mocks.readAnswers.mockResolvedValue({});
  mocks.rememberAnswers.mockResolvedValue(undefined);
  mocks.forgetAnswers.mockResolvedValue(undefined);
  mocks.rememberPhone.mockResolvedValue(undefined);
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.stageFile.mockResolvedValue(undefined);
  mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
    if (request.code.includes("loginWall")) {
      return { success: true, result: { loginWall: false } };
    }
    if (request.code.includes("const empty = await")) {
      return { result: { empty: [] }, success: true };
    }
    if (request.code.includes("const fields = await")) {
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
    return { result: { filled: ["#email"], skipped: [] }, success: true };
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

describe("incomplete forms never reach approval", () => {
  const run = () =>
    fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });

  it("pauses naming a required question the page still shows blank", async () => {
    // The Hightouch failure: a control the mapper never saw stayed empty, and
    // the run offered the form for approval anyway.
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return {
          result: {
            empty: [
              {
                label: "Are you authorized to work for any employer in the US?",
                selector: "#work-auth",
              },
            ],
          },
          success: true,
        };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [] }, success: true };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });

    const result = await run();

    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "authorized to work"
    );
  });

  it("keeps going when the page reports nothing blank", async () => {
    await expect(run()).resolves.toEqual({ continue: true });
  });
});

describe("submitApplication", () => {
  const submit = () =>
    submitApplication({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });

  it("does not report a submission the posting never confirmed", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) =>
      request.code.includes("const empty = await")
        ? { result: { empty: [] }, success: true }
        : {
            result: {
              clicked: true,
              errors: ["This field is required."],
              navigated: false,
            },
            success: true,
          }
    );
    mocks.inspect.mockResolvedValue({ submitted: false });

    const result = await submit();

    expect(result).not.toHaveProperty("done");
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "This field is required."
    );
    // The run stays open for the candidate rather than being closed as sent.
    expect(mocks.updateApplicationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "waiting" })
    );
  });

  it("never clicks submit on a form that is still short", async () => {
    // Approval used to go straight to the click, so a run whose last pause
    // named a blank required question submitted anyway: the page refused it
    // in silence, nothing navigated, and the candidate was told only that it
    // had not gone through.
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const empty = await")) {
        return {
          result: { empty: [{ label: "LinkedIn Profile*", selector: "#li" }] },
          success: true,
        };
      }
      return { result: { clicked: true, errors: [] }, success: true };
    });

    const result = await submit();

    expect(result).toMatchObject({
      pause: "user_input",
      questions: [{ label: "LinkedIn Profile*" }],
    });
    const codes = mocks.executePlaywright.mock.calls.map(
      (call) => call[1].code
    );
    expect(codes.some((code) => code.includes("getByRole"))).toBe(false);
  });

  it("carries the browser's own verdict when the page renders no message", async () => {
    // A form can refuse a submit with nothing drawn anywhere, which is how a
    // blocked submit came back reporting no errors at all.
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      return {
        result: {
          clicked: true,
          errors: [],
          invalid: ["LinkedIn Profile: Please fill out this field."],
          navigated: false,
        },
        success: true,
      };
    });
    mocks.inspect.mockResolvedValue({ submitted: false });

    const result = await submit();

    expect("message" in result ? result.message : "").toContain(
      "Please fill out this field."
    );
  });

  it("records what the page did, so a submission is never in doubt", async () => {
    // The one transition that mattered most wrote no log line, so a submitted
    // application and a refused one read identically afterwards.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) =>
      request.code.includes("const empty = await")
        ? { result: { empty: [] }, success: true }
        : {
            result: {
              clicked: true,
              errors: ["This field is required."],
              navigated: false,
            },
            success: true,
          }
    );
    mocks.inspect.mockResolvedValue({ submitted: false });

    await submit();

    const logged = info.mock.calls.map((call) => JSON.stringify(call));
    const submitLine = logged.find((line) => line.includes("runner.submit"));
    expect(submitLine).toContain('"status":"blocked"');
    expect(submitLine).toContain('"submitted":false');
    expect(submitLine).toContain('"clicked":true');
    expect(submitLine).toContain("This field is required.");
    info.mockRestore();
  });

  it("reports done once the posting confirms it", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) =>
      request.code.includes("const empty = await")
        ? { result: { empty: [] }, success: true }
        : {
            result: { clicked: true, errors: [], navigated: true },
            success: true,
          }
    );
    mocks.inspect.mockResolvedValue({ submitted: true });

    await expect(submit()).resolves.toMatchObject({ done: true });
    expect(mocks.updateApplicationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    );
  });
});

describe("a field with no readable label", () => {
  const unlabelledField = {
    label: "",
    name: "",
    required: true,
    selector: "(input)[10]",
    tag: "input",
    type: "text",
  };

  const run = () =>
    fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });

  beforeEach(() => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return {
          result: {
            empty: [
              {
                label: "",
                nearby: "Do you have experience with dbt? Yes No",
                selector: "(input)[10]",
                tag: "text",
              },
            ],
          },
          success: true,
        };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [unlabelledField] }, success: true };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
  });

  it("never puts a CSS selector to the candidate as a question", async () => {
    // The candidate was asked "(input)[10]" — our own positional selector.
    const result = await run();

    const message = "message" in result ? result.message : "";
    expect(message).not.toContain("(input)");
    expect(message).toContain("no label I can read");
  });

  it("does not ask the helper about a field it cannot name", async () => {
    await run();

    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});

describe("the candidate's answers, keyed by question", () => {
  const workAuth = {
    label: "Are you authorized to work for any employer in the U.S?*",
    name: "question_1",
    required: true,
    selector: "#work-auth",
    tag: "combobox",
    type: "text",
  };
  const sponsorship = {
    label:
      "Will you now or in the future require sponsorship for employment visa status?*",
    name: "question_2",
    required: true,
    selector: "#sponsorship",
    tag: "combobox",
    type: "text",
  };

  const run = (answered?: Record<string, string>) =>
    fillVisibleForm({
      answered,
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });

  beforeEach(() => {
    mocks.saveCandidateProfile.mockResolvedValue({ stored: true });
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [workAuth, sponsorship] }, success: true };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
  });

  it("fills the named control and keeps the fact, with no model in between", async () => {
    // The loop the candidate lived through: they answered, the answer reached
    // only the helper for one pass, the next round re-derived from the profile
    // and asked again.
    const result = await run({
      [workAuth.label]: "Yes",
      [sponsorship.label]: "No",
    });

    expect(result).toEqual({ continue: true });
    expect(mocks.generateText).not.toHaveBeenCalled();
    const fillCode = mocks.executePlaywright.mock.calls
      .map((call) => call[1].code)
      .find((code) => code.includes("const fills = "));
    expect(fillCode).toContain("#work-auth");
    expect(fillCode).toContain("#sponsorship");
    expect(mocks.saveCandidateProfile).toHaveBeenCalledWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      {
        requiresSponsorshipFuture: "no",
        requiresSponsorshipNow: "no",
        workAuthorization: "us_visa_no_sponsorship",
      }
    );
  });

  it("overrides a stored profile value the page refused", async () => {
    mocks.profile.mockResolvedValue({
      ...emptyCandidateProfile,
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      workAuthorization: "other",
    });

    await run({ [workAuth.label]: "U.S. Citizen" });

    expect(mocks.saveCandidateProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workAuthorization: "us_citizen" })
    );
  });

  it("hands an answer whose question is gone to the helper as text", async () => {
    mocks.profile.mockResolvedValue({
      ...emptyCandidateProfile,
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      workAuthorization: "us_citizen",
      requiresSponsorshipNow: "no",
    });
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return {
          result: {
            fields: [
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
      return { result: { filled: [], skipped: [] }, success: true };
    });
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({ fills: [{ selector: "#color", value: "blue" }] }),
    });

    await run({ "What is your favourite colour": "blue" });

    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("What is your favourite colour: blue");
    // The helper now sees the whole profile, not four strings.
    expect(prompt).toContain("Work authorization: us_citizen");
  });
});

describe("a control that refuses every phrasing", () => {
  const workAuth = {
    label: "Are you authorized to work for any employer in the U.S?*",
    name: "question_1",
    required: true,
    selector: "#work-auth",
    tag: "combobox",
    type: "text",
  };

  beforeEach(() => {
    mocks.profile.mockResolvedValue({
      ...emptyCandidateProfile,
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      workAuthorization: "other",
    });
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({ blockers: [workAuth.label], fills: [] }),
    });
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return {
          result: {
            empty: [{ label: workAuth.label, selector: workAuth.selector }],
          },
          success: true,
        };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [workAuth] }, success: true };
      }
      return {
        result: {
          filled: [],
          offered: { selector: "#work-auth", options: ["Yes", "No"] },
          skipped: [{ reason: "no-option", selector: "#work-auth" }],
        },
        success: true,
      };
    });
  });

  it("asks the question once, carrying the page's own choices", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { result: { loginWall: false }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return {
          result: {
            empty: [{ label: workAuth.label, selector: workAuth.selector }],
          },
          success: true,
        };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [workAuth] }, success: true };
      }
      return {
        result: {
          filled: [],
          offered: [{ options: ["Yes", "No"], selector: "#work-auth" }],
          skipped: [{ reason: "no-option", selector: "#work-auth" }],
        },
        success: true,
      };
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
      pause: "user_input",
      questions: [
        {
          label: "Are you authorized to work for any employer in the U.S?*",
          options: ["Yes", "No"],
        },
      ],
    });
    expect("message" in result ? result.message : "").toContain("Yes / No");
    // The refused control went back to the helper with the real options, so
    // the model was consulted about it exactly once.
    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain('"options":["Yes","No"]');
  });
});

describe("attaching the resume", () => {
  const resumeField = {
    label: "Resume/CV*",
    name: "resume",
    required: false,
    selector: "#resume",
    tag: "file",
    type: "file",
  };
  const run = () =>
    fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
    });
  const attachCalls = () =>
    mocks.executePlaywright.mock.calls
      .map((call) => call[1].code)
      .filter((code) => code.includes("const stagedPath ="));
  const pageWithResumeSlot = (
    attach: () => { ok: boolean; reason?: string; via?: string }
  ) => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const stagedPath =")) {
        return { result: attach(), success: true };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
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
              resumeField,
            ],
          },
          success: true,
        };
      }
      return { result: { filled: ["#email"], skipped: [] }, success: true };
    });
  };

  beforeEach(() => {
    mocks.providerName.value = "gateway";
    mocks.resume.mockResolvedValue({
      bytes: Buffer.from("%PDF-1.4 resume"),
      filename: "Ada Lovelace.pdf",
      mimeType: "application/pdf",
    });
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({ fills: [] }),
    });
  });

  it("sends the bytes first on the gateway, where a staged path attaches nothing", async () => {
    // The gateway runs the script in its own process and the browser sits at
    // Brightdata; Chromium resolves a path on its machine, finds nothing, and
    // attaches nothing without a word. That is the DoorDash resume.
    pageWithResumeSlot(() => ({ ok: true, via: "payload" }));
    expect(await run()).toEqual({ continue: true });
    const [code] = attachCalls();
    expect(code).toContain('const order = ["payload","path"]');
    const request = mocks.executePlaywright.mock.calls.find((call) =>
      call[1].code.includes("const stagedPath =")
    )?.[1];
    expect(request).toMatchObject({ timeoutSec: 90 });
  });

  it("keeps the staged path first on Kernel, where the code runs beside the browser", async () => {
    mocks.providerName.value = "kernel";
    pageWithResumeSlot(() => ({ ok: true, via: "path" }));
    expect(await run()).toEqual({ continue: true });
    const [code] = attachCalls();
    expect(code).toContain('const order = ["path","payload"]');
  });

  it("carries the browser's own error into the pause when the script dies", async () => {
    // Run 3 on the gateway logged "the browser returned nothing": the script
    // had timed out and the error text was thrown away with the result.
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const stagedPath =")) {
        return { error: "Execution timed out after 30s", success: false };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [resumeField] }, success: true };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
    const result = await run();
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toMatch(
      /could not be attached to Resume\/CV\*.*Execution timed out after 30s/u
    );
  });

  it("makes no second attach on a round where the page already shows the file", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const stagedPath =")) {
        return {
          result: { ok: true, via: "already-attached", shown: true },
          success: true,
        };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return {
          result: {
            fields: [
              {
                ...resumeField,
                label: "Attach",
                name: "",
                selector: "#cover_letter",
              },
            ],
          },
          success: true,
        };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
    expect(await run()).toEqual({ continue: true });
    // The mapper offered no slot, so the script ran in search mode and the
    // page's own word, the filename already shown, settled it.
    const [code] = attachCalls();
    expect(code).toContain('const scanned = ""');
  });

  it("names a slot labelled only by its Attach button as the resume", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const stagedPath =")) {
        return {
          result: { ok: false, reason: "path: refused" },
          success: true,
        };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return {
          result: { fields: [{ ...resumeField, label: "Attach" }] },
          success: true,
        };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
    const result = await run();
    expect("message" in result ? result.message : "").toMatch(
      /could not be attached to Resume\/CV on/u
    );
  });

  it("stages the file, attaches it to the scanned slot, and reads the result", async () => {
    pageWithResumeSlot(() => ({ ok: true, via: "path" }));
    expect(await run()).toEqual({ continue: true });
    const [sessionId, file] = mocks.stageFile.mock.calls[0] ?? [];
    expect(sessionId).toBe("browser-1");
    expect(file?.path).toBe("/tmp/goforay-default-resume-Ada_Lovelace.pdf");
    expect(Buffer.from(file?.bytes ?? []).toString()).toBe("%PDF-1.4 resume");
    const [code] = attachCalls();
    expect(code).toContain('"#resume"');
    expect(code).toContain("/tmp/goforay-default-resume-Ada_Lovelace.pdf");
    // The bytes ride along for the fallback, never a Buffer reference.
    expect(code).toContain(Buffer.from("%PDF-1.4 resume").toString("base64"));
    // The helper never sees a file control.
    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toContain("Resume/CV");
  });

  it("still attaches by payload when staging the path failed", async () => {
    // A stage that threw used to read as no resume at all, and the slot was
    // dropped without a word.
    mocks.stageFile.mockRejectedValue(new Error("fs unavailable"));
    pageWithResumeSlot(() => ({ ok: true, via: "payload" }));
    expect(await run()).toEqual({ continue: true });
    const [code] = attachCalls();
    expect(code).toContain('const stagedPath = ""');
    expect(code).toContain(Buffer.from("%PDF-1.4 resume").toString("base64"));
  });

  it("pauses with the reason when the slot refuses the file, and never asks for a new upload", async () => {
    pageWithResumeSlot(() => ({
      ok: false,
      reason: "path: ENOENT: no such file | payload: rejected",
    }));
    const result = await run();
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toMatch(
      /could not be attached to Resume\/CV\*.*ENOENT.*do not ask the candidate for it again/u
    );
    expect(mocks.updateApplicationRun).toHaveBeenCalledWith({
      executionId: "exec-1",
      pauseReason: "user_input",
      status: "waiting",
    });
  });

  it("looks for a resume slot the scan missed, and accepts a form with none", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const stagedPath =")) {
        return { result: { ok: false, reason: "missing" }, success: true };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
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
            ],
          },
          success: true,
        };
      }
      return { result: { filled: ["#email"], skipped: [] }, success: true };
    });
    expect(await run()).toEqual({ continue: true });
    const [code] = attachCalls();
    expect(code).toContain('const scanned = ""');
  });

  it("asks for the resume when none is on file and the form has a slot for one", async () => {
    mocks.resume.mockResolvedValue(undefined);
    pageWithResumeSlot(() => ({ ok: true }));
    const result = await run();
    expect(attachCalls()).toEqual([]);
    expect(result).toMatchObject({
      pause: "user_input",
      questions: [{ label: "Resume/CV*" }],
    });
    expect("message" in result ? result.message : "").toMatch(
      /no resume is on file/u
    );
    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).not.toContain("Resume/CV");
  });
});

describe("a verification step after the submit", () => {
  const input = {
    applyUrl: "https://job-boards.greenhouse.io/doordashusa/jobs/1",
    browserSessionId: "browser-1",
    company: "DoorDash",
    executionId: "exec-1",
    role: "Analyst",
    rootSessionId: "root-1",
    scope: { userId: "alice", workspaceId: "workspace:alice" },
  };
  const askingForCode = {
    channel: "email",
    count: 1,
    hint: "Greenhouse",
    present: true,
    prompt: "We sent a verification code to your email.",
  };
  const page = (options: { asks: unknown; entered?: unknown }) => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (
        request.code.includes("const codeContext =") &&
        request.code.includes("const found = await")
      ) {
        return { result: options.asks, success: true };
      }
      if (request.code.includes("const code = ")) {
        return { result: options.entered, success: true };
      }
      // The submit click.
      return {
        result: { clicked: true, errors: [], navigated: false },
        success: true,
      };
    });
  };

  it("pauses for the emailed code instead of calling the submit refused", async () => {
    // The DoorDash click came back clicked, no navigation, no errors, not
    // submitted: Greenhouse had opened its emailed-code dialog. Reported as a
    // failed submit, the agent had no reason to go to Gmail for the code.
    page({ asks: askingForCode });
    mocks.inspect.mockResolvedValue({ submitted: false });
    const result = await submitApplication(input);
    expect(result).toMatchObject({ pause: "email_otp" });
    expect("message" in result ? result.message : "").toMatch(
      /^Needs email OTP: Greenhouse is asking for the verification code it just emailed/u
    );
    expect(mocks.updateApplicationRun).toHaveBeenCalledWith({
      executionId: "exec-1",
      pauseReason: "email_otp",
      status: "waiting",
    });
  });

  it("finishes the application once the code is taken and the page confirms", async () => {
    page({
      asks: askingForCode,
      entered: {
        clicked: true,
        confirmed: true,
        entered: true,
        errors: [],
        remaining: 0,
      },
    });
    mocks.inspect.mockResolvedValue({ submitted: false });
    const result = await enterVerificationCode({ ...input, code: "482 913" });
    expect(result).toMatchObject({ done: true });
    const typed = mocks.executePlaywright.mock.calls.find((call) =>
      call[1].code.includes("const code = ")
    )?.[1].code;
    // Whitespace stripped, and the code never reaches the log.
    expect(typed).toContain('const code = "482913"');
    expect(mocks.updateApplicationRun).toHaveBeenCalledWith({
      executionId: "exec-1",
      pauseReason: null,
      status: "completed",
    });
  });

  it("asks again, with the page's complaint, when the code is refused", async () => {
    page({
      asks: askingForCode,
      entered: {
        clicked: true,
        confirmed: false,
        entered: true,
        errors: ["That code is incorrect."],
        remaining: 1,
      },
    });
    mocks.inspect.mockResolvedValue({ submitted: false });
    const result = await enterVerificationCode({ ...input, code: "000000" });
    expect(result).toMatchObject({ pause: "email_otp" });
    expect(result && "message" in result ? result.message : "").toContain(
      "The last code was not accepted: That code is incorrect."
    );
  });

  it("does nothing when no code is being asked for", async () => {
    page({ asks: { present: false } });
    mocks.inspect.mockResolvedValue({ submitted: false });
    expect(await enterVerificationCode({ ...input, code: "482913" })).toBe(
      undefined
    );
    expect(
      mocks.executePlaywright.mock.calls.some((call) =>
        call[1].code.includes("const code = ")
      )
    ).toBe(false);
  });
});

describe("a code dialog made of boxes", () => {
  const input = {
    applyUrl: "https://job-boards.greenhouse.io/doordashusa/jobs/1",
    browserSessionId: "browser-1",
    company: "DoorDash",
    executionId: "exec-1",
    role: "Analyst",
    rootSessionId: "root-1",
    scope: { userId: "alice", workspaceId: "workspace:alice" },
  };
  const securityBoxes = Array.from({ length: 7 }, (_, index) => ({
    label: "",
    nearby: "",
    selector: `#security-input-${String(index + 1)}`,
    tag: "text",
  }));

  it("pauses for the code, never for seven fields nobody can name", async () => {
    // Greenhouse's dialog is #security-input-1 .. 7, type=text, no label and
    // no autocomplete. The blank scan saw seven unlabelled required fields and
    // said so; the candidate had already pasted the code.
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const found = await page.evaluate")) {
        return {
          result: {
            channel: "email",
            count: 7,
            hint: "Greenhouse",
            present: true,
            prompt: "Enter the code we sent to your email.",
          },
          success: true,
        };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: securityBoxes }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return { result: { fields: [] }, success: true };
      }
      return { result: { filled: [], skipped: [] }, success: true };
    });
    const result = await fillVisibleForm(input);
    expect(result).toMatchObject({ pause: "email_otp" });
    expect("message" in result ? result.message : "").not.toContain(
      "carry no label"
    );
  });
});

describe("what a run remembers", () => {
  const run = (answered?: Record<string, string>) =>
    fillVisibleForm({
      applyUrl: "https://jobs.example/role/1",
      browserSessionId: "browser-1",
      company: "Example",
      executionId: "exec-1",
      role: "Analyst",
      rootSessionId: "root-1",
      scope: { userId: "alice", workspaceId: "workspace:alice" },
      ...(answered ? { answered } : {}),
    });

  it("re-applies the answers a candidate already gave on this run", async () => {
    // The browser died between rounds and a fresh one was opened: the form
    // came back from the top and asked "Have you worked at DoorDash?" again.
    mocks.readAnswers.mockResolvedValue({ "Favorite color": "blue" });
    expect(await run()).toEqual({ continue: true });
    const codes = mocks.executePlaywright.mock.calls.map(
      (call) => call[1].code
    );
    expect(codes.some((code) => code.includes('"#color"'))).toBe(true);
    // Nothing left for the helper to guess at.
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("keeps this round's answers for the next round", async () => {
    expect(await run({ "Favorite color": "green" })).toEqual({
      continue: true,
    });
    expect(mocks.rememberAnswers).toHaveBeenCalledWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      "exec-1",
      { "Favorite color": "green" }
    );
  });

  it("keeps a phone number the candidate typed, so it is never asked twice", async () => {
    mocks.executePlaywright.mockImplementation(async (_sessionId, request) => {
      if (request.code.includes("loginWall")) {
        return { success: true, result: { loginWall: false } };
      }
      if (request.code.includes("const empty = await")) {
        return { result: { empty: [] }, success: true };
      }
      if (request.code.includes("const fields = await")) {
        return {
          result: {
            fields: [
              {
                label: "Phone*",
                name: "phone",
                required: true,
                selector: "#phone",
                tag: "input",
                type: "tel",
              },
            ],
          },
          success: true,
        };
      }
      return { result: { filled: ["#phone"], skipped: [] }, success: true };
    });
    expect(await run({ "Phone*": "(415) 555-0100" })).toEqual({
      continue: true,
    });
    expect(mocks.rememberPhone).toHaveBeenCalledWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      "(415) 555-0100"
    );
  });
});
