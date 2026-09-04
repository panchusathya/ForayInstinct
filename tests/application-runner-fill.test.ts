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
    mocks.resume.mockResolvedValue({
      bytes: Buffer.from("%PDF-1.4 resume"),
      filename: "Ada Lovelace.pdf",
      mimeType: "application/pdf",
    });
    mocks.generateText.mockResolvedValue({
      text: JSON.stringify({ fills: [] }),
    });
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
