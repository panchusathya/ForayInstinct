import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureApproval: vi.fn<() => Promise<Record<string, unknown>>>(),
  closeBrowser: vi.fn<(_input: Record<string, unknown>) => Promise<void>>(),
  fill: vi.fn<
    (_input: Record<string, unknown>) => Promise<Record<string, unknown>>
  >(),
  findRun: vi.fn<() => Promise<unknown>>(),
  openBrowser:
    vi.fn<
      (_input: Record<string, unknown>) => Promise<{ session_id: string }>
    >(),
  updateRun: vi.fn<(_input: Record<string, unknown>) => Promise<void>>(),
  click: vi.fn<() => Promise<Record<string, unknown>>>(),
  decide: vi.fn<() => Promise<Record<string, unknown>>>(),
  log: vi.fn<(_entry: Record<string, unknown>) => void>(),
  summary: vi.fn<() => Promise<Record<string, unknown> | undefined>>(),
}));

vi.mock("@/lib/application-execution", () => ({
  applicationExecutionLog: mocks.log,
}));

vi.mock("@/lib/application-runner/navigate", () => ({
  clickControl: mocks.click,
  decideNextStep: mocks.decide,
  readPageSummary: mocks.summary,
}));

vi.mock("@/db/services/application-executions", () => ({
  findApplicationRun: mocks.findRun,
  updateApplicationRun: mocks.updateRun,
}));

vi.mock("@/lib/application-runner/browser", () => ({
  closeApplicationBrowser: mocks.closeBrowser,
  openApplicationBrowser: mocks.openBrowser,
}));

vi.mock("@/lib/application-runner/fill", () => ({
  captureApproval: mocks.captureApproval,
  enterVerificationCode: vi.fn<() => Promise<undefined>>(),
  fillVisibleForm: mocks.fill,
  submitApplication: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

import { runApplicationUntilPause } from "@/lib/application-runner/run";

const input = {
  applyUrl: "https://hirro.example/job/associate-finance",
  company: "Hirro",
  executionId: "exec-1",
  role: "Associate",
  rootSessionId: "root-1",
  scope: { userId: "alice", workspaceId: "workspace:alice" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRun.mockResolvedValue({ browserSessionId: "browser-1" });
  mocks.updateRun.mockResolvedValue(undefined);
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.openBrowser.mockResolvedValue({ session_id: "browser-2" });
  mocks.captureApproval.mockResolvedValue({
    applyUrl: input.applyUrl,
    message: "Needs submission approval: Associate",
    pause: "approval",
  });
  mocks.summary.mockResolvedValue({
    controls: [
      { disabled: false, href: "", index: 4, text: "Submit application" },
    ],
    fields: 0,
    heading: "Apply for this job",
    href: input.applyUrl,
    progress: "",
    title: "Associate",
  });
  mocks.decide.mockResolvedValue({
    action: "submit",
    control: {
      disabled: false,
      href: "",
      index: 4,
      text: "Submit application",
    },
    via: "heuristic",
  });
});

const advance = (text: string) => ({
  action: "advance",
  control: { disabled: false, href: "", index: 1, text },
  via: "heuristic",
});

const advanceLogs = () =>
  mocks.log.mock.calls
    .map((call) => call[0])
    .filter((entry) => entry.event === "runner.advance");

describe("a form on one page", () => {
  it("goes straight to approval without pressing anything", async () => {
    // Greenhouse, Ashby, Lever: the page's forward control is the submit, so
    // the loop's first decision is "submit" and nothing is clicked before the
    // candidate reviews.
    mocks.fill.mockResolvedValue({ continue: true });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "approval" });
    expect(mocks.fill).toHaveBeenCalledTimes(1);
    expect(mocks.click).not.toHaveBeenCalled();
    expect(mocks.captureApproval).toHaveBeenCalledWith({
      ...input,
      browserSessionId: "browser-1",
    });
  });
});

describe("a form over several pages", () => {
  it("fills each page, presses the page's continue, and asks approval on the last", async () => {
    mocks.fill.mockResolvedValue({ continue: true });
    mocks.summary
      .mockResolvedValueOnce({
        controls: [],
        fields: 6,
        heading: "My Information",
      })
      .mockResolvedValueOnce({
        controls: [],
        fields: 9,
        heading: "My Experience",
      })
      .mockResolvedValueOnce({ controls: [], fields: 0, heading: "Review" });
    mocks.decide
      .mockResolvedValueOnce(advance("Save and Continue"))
      .mockResolvedValueOnce(advance("Save and Continue"))
      .mockResolvedValueOnce({
        action: "submit",
        control: { disabled: false, href: "", index: 2, text: "Submit" },
        via: "model",
      });
    mocks.click
      .mockResolvedValueOnce({
        clicked: true,
        errors: [],
        heading: "My Experience",
        href: "https://acme.example/apply/2",
        navigated: true,
      })
      .mockResolvedValueOnce({
        clicked: true,
        errors: [],
        heading: "Review",
        href: "https://acme.example/apply/2",
        navigated: false,
      });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "approval" });
    expect(mocks.fill).toHaveBeenCalledTimes(3);
    expect(mocks.click).toHaveBeenCalledTimes(2);
    expect(advanceLogs()).toEqual([
      expect.objectContaining({
        control: "Save and Continue",
        from: "My Information",
        moved: true,
        page: 1,
        to: "My Experience",
        via: "heuristic",
      }),
      expect.objectContaining({
        from: "My Experience",
        moved: true,
        page: 2,
        to: "Review",
      }),
    ]);
    // Only page wording reaches the log.
    for (const entry of advanceLogs()) {
      expect(Object.keys(entry).sort()).toEqual([
        "apply_url",
        "control",
        "errors",
        "event",
        "execution_id",
        "from",
        "moved",
        "page",
        "to",
        "via",
      ]);
    }
  });

  it("stops and carries the page's own words when it refuses to continue", async () => {
    mocks.fill.mockResolvedValue({ continue: true });
    mocks.summary.mockResolvedValue({
      controls: [],
      fields: 6,
      heading: "My Information",
    });
    mocks.decide.mockResolvedValue(advance("Next"));
    mocks.click.mockResolvedValue({
      clicked: true,
      errors: ["Country Phone Code is required."],
      heading: "My Information",
      href: input.applyUrl,
      navigated: false,
    });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "My Information would not continue: Country Phone Code is required."
    );
    expect(mocks.click).toHaveBeenCalledTimes(1);
    expect(mocks.updateRun).toHaveBeenCalledWith({
      browserSessionId: "browser-1",
      executionId: "exec-1",
      pauseReason: "user_input",
      status: "waiting",
    });
    expect(mocks.captureApproval).not.toHaveBeenCalled();
  });

  it("gives up after a page stays put twice with nothing said", async () => {
    mocks.fill.mockResolvedValue({ continue: true });
    mocks.summary.mockResolvedValue({
      controls: [
        { disabled: false, href: "", index: 0, text: "Back" },
        { disabled: false, href: "", index: 1, text: "Next" },
      ],
      fields: 6,
      heading: "Questions",
    });
    mocks.decide.mockResolvedValue(advance("Next"));
    mocks.click.mockResolvedValue({
      clicked: true,
      errors: [],
      heading: "Questions",
      href: input.applyUrl,
      navigated: false,
    });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "Questions on https://hirro.example/job/associate-finance is filled in, but no control on it moves the application on (controls seen: Back, Next)"
    );
    expect(mocks.click).toHaveBeenCalledTimes(2);
    expect(mocks.fill).toHaveBeenCalledTimes(1);
  });

  it("pauses, naming the controls, when no control moves the form on", async () => {
    mocks.fill.mockResolvedValue({ continue: true });
    mocks.summary.mockResolvedValue({
      controls: [],
      fields: 2,
      heading: "Voluntary Disclosures",
    });
    mocks.decide.mockResolvedValue({
      action: "stuck",
      controls: ["Save for Later", "Back"],
      via: "model",
    });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "controls seen: Save for Later, Back"
    );
    expect(mocks.click).not.toHaveBeenCalled();
  });

  it("leaves a mid-form question to the candidate before pressing on", async () => {
    mocks.fill.mockResolvedValueOnce({
      applyUrl: input.applyUrl,
      message: "Needs input: Are you legally authorized to work in the US?",
      pause: "user_input",
    });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
  });
});

describe("a posting whose form is on another site", () => {
  it("reopens the browser where the form is and fills there", async () => {
    // The browser is pinned to one site and dies on a cross-site hop, so the
    // hop is a new browser, not a click.
    mocks.fill
      .mockResolvedValueOnce({
        applyUrl: input.applyUrl,
        redirect: "https://boards.greenhouse.io/hirro/jobs/123",
      })
      .mockResolvedValueOnce({ continue: true });
    const result = await runApplicationUntilPause(input);
    expect(mocks.closeBrowser).toHaveBeenCalledWith({
      scope: input.scope,
      sessionId: "browser-1",
    });
    expect(mocks.openBrowser).toHaveBeenCalledWith({
      applyUrl: "https://boards.greenhouse.io/hirro/jobs/123",
      executionId: "exec-1",
      scope: input.scope,
    });
    expect(mocks.updateRun).toHaveBeenCalledWith({
      browserSessionId: "browser-2",
      executionId: "exec-1",
    });
    expect(mocks.fill.mock.calls[1]?.[0]).toMatchObject({
      applyUrl: "https://boards.greenhouse.io/hirro/jobs/123",
      browserSessionId: "browser-2",
    });
    expect(result).toMatchObject({ pause: "approval" });
  });

  it("stops at a chain of redirects and says where it led", async () => {
    mocks.fill
      .mockResolvedValueOnce({
        applyUrl: input.applyUrl,
        redirect: "https://one.example/apply",
      })
      .mockResolvedValueOnce({
        applyUrl: "https://one.example/apply",
        redirect: "https://two.example/apply",
      });
    const result = await runApplicationUntilPause(input);
    expect(result).toMatchObject({ pause: "user_input" });
    expect("message" in result ? result.message : "").toContain(
      "sends them on again to https://two.example/apply"
    );
    expect(mocks.openBrowser).toHaveBeenCalledTimes(1);
  });
});
