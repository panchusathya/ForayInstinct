import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executePlaywright:
    vi.fn<
      (
        _sessionId: string,
        _request: { code: string; timeoutSec?: number }
      ) => Promise<{ error?: string; result?: unknown; success: boolean }>
    >(),
  generateText:
    vi.fn<(_input: { prompt: string }) => Promise<{ text: string }>>(),
}));

vi.mock("@/lib/model-config", () => ({
  chatLanguageModel: "test-model",
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

vi.mock("@/lib/browser", () => ({
  browserProvider: { executePlaywright: mocks.executePlaywright },
}));

import {
  clickControl,
  decideNextStep,
  type PageControl,
  readPageSummary,
} from "@/lib/application-runner/navigate";

const control = (
  index: number,
  text: string,
  disabled = false
): PageControl => ({
  disabled,
  href: "",
  index,
  text,
});

const summary = (controls: PageControl[], heading = "My Information") => ({
  controls,
  fields: 4,
  heading,
  href: "https://acme.wd5.myworkdayjobs.com/apply",
  progress: "",
  title: "Apply",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deciding how a page moves on", () => {
  it("decides submit on a one-page board without asking the model", async () => {
    // Greenhouse: Attach, Dropbox, Google Drive, Enter manually, Submit
    // application. The board's own one-page form is the DoorDash case and
    // must reach approval with no click before it.
    const step = await decideNextStep(
      summary([
        control(0, "Attach"),
        control(1, "Dropbox"),
        control(2, "Google Drive"),
        control(3, "Enter manually"),
        control(4, "Submit application"),
        control(5, "Privacy Policy"),
      ])
    );
    expect(step).toEqual({
      action: "submit",
      control: control(4, "Submit application"),
      via: "heuristic",
    });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("decides advance on a wizard page whose only forward control saves and continues", async () => {
    const step = await decideNextStep(
      summary([
        control(0, "Back"),
        control(1, "Save and Continue"),
        control(2, "Add"),
        control(3, "Save for Later"),
      ])
    );
    expect(step).toEqual({
      action: "advance",
      control: control(1, "Save and Continue"),
      via: "heuristic",
    });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("asks the model once when both kinds of control are present and honours its index", async () => {
    mocks.generateText.mockResolvedValue({
      text: 'Sure. {"action":"advance","index":2,"why":"review comes before submit"}',
    });
    const step = await decideNextStep(
      summary(
        [control(0, "Back"), control(1, "Submit"), control(2, "Review")],
        "Review"
      )
    );
    expect(step).toEqual({
      action: "advance",
      control: control(2, "Review"),
      via: "model",
    });
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const prompt = mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("Page heading: Review");
    // The model chooses from the controls code kept; denied ones are not
    // offered to it at all.
    expect(prompt).toContain('"text":"Review"');
    expect(prompt).not.toContain('"text":"Back"');
  });

  it("treats a denied, disabled, or out-of-range answer as no answer", async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: '{"action":"advance","index":0}',
    });
    const controls = [
      control(0, "Back"),
      control(1, "Submit"),
      control(2, "Continue", true),
      control(3, "Next"),
    ];
    expect(await decideNextStep(summary(controls))).toMatchObject({
      action: "stuck",
      controls: ["Submit", "Next"],
      via: "model",
    });
    mocks.generateText.mockResolvedValueOnce({
      text: '{"action":"advance","index":2}',
    });
    expect(await decideNextStep(summary(controls))).toMatchObject({
      action: "stuck",
    });
    mocks.generateText.mockResolvedValueOnce({
      text: '{"action":"submit","index":9}',
    });
    expect(await decideNextStep(summary(controls))).toMatchObject({
      action: "stuck",
    });
    mocks.generateText.mockResolvedValueOnce({ text: "no idea" });
    expect(await decideNextStep(summary(controls))).toMatchObject({
      action: "stuck",
    });
  });

  it("is stuck without a model call when nothing on the page can be pressed", async () => {
    expect(
      await decideNextStep(
        summary([
          control(0, "Back"),
          control(1, "Cancel"),
          control(2, "Next", true),
        ])
      )
    ).toEqual({ action: "stuck", controls: [], via: "heuristic" });
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});

describe("reading and pressing the page's controls", () => {
  it("numbers controls from one locator list and clicks by that number", async () => {
    const scripts = readFileSync(
      "lib/application-runner/playwright-scripts.ts",
      "utf8"
    );
    const collect = scripts.slice(
      scripts.indexOf("export const collectPageControlsCode"),
      scripts.indexOf("export const clickControlCode")
    );
    const click = scripts.slice(
      scripts.indexOf("export const clickControlCode"),
      scripts.indexOf("export const detectLoginWallCode")
    );
    // Both scripts enumerate the same selector, so index N means the same
    // node in the summary and in the click.
    expect(collect).toContain(
      'document.querySelectorAll("${pageControlsLocator}")'
    );
    expect(click).toContain(
      'page.locator("${pageControlsLocator}").nth(${String(index)})'
    );
    mocks.executePlaywright.mockResolvedValue({
      result: {
        clicked: true,
        errors: [],
        heading: "My Experience",
        href: "https://acme.wd5.myworkdayjobs.com/apply/2",
        navigated: true,
      },
      success: true,
    });
    const outcome = await clickControl(
      "browser-1",
      control(7, "Save and Continue")
    );
    expect(outcome).toMatchObject({
      heading: "My Experience",
      navigated: true,
    });
    expect(mocks.executePlaywright.mock.calls[0]?.[1]?.code).toContain(
      ".nth(7)"
    );
  });

  it("reports a failed script as nothing read, and a failed click as not clicked", async () => {
    mocks.executePlaywright.mockResolvedValue({
      error: "Target closed",
      success: false,
    });
    expect(await readPageSummary("browser-1")).toBeUndefined();
    expect(await clickControl("browser-1", control(1, "Next"))).toEqual({
      clicked: false,
      errors: ["Target closed"],
      heading: "",
      href: "",
      navigated: false,
    });
  });
});
