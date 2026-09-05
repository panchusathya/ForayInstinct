import { generateText } from "ai";
import { z } from "zod";
import { applicationExecutionLog } from "@/lib/application-execution";
import {
  clickControlCode,
  collectPageControlsCode,
} from "@/lib/application-runner/playwright-scripts";
import { browserProvider } from "@/lib/browser";
import { chatLanguageModel } from "@/lib/model-config";
import { COORDINATOR_MAX_OUTPUT_TOKENS } from "@/lib/model-request";

const pageControlSchema = z.object({
  disabled: z.boolean().default(false),
  href: z.string().default(""),
  index: z.number().int().min(0),
  text: z.string(),
});

const pageSummarySchema = z.object({
  controls: z.array(pageControlSchema).default([]),
  fields: z.number().default(0),
  heading: z.string().default(""),
  href: z.string().default(""),
  progress: z.string().default(""),
  title: z.string().default(""),
});

export type PageControl = z.infer<typeof pageControlSchema>;
export type PageSummary = z.infer<typeof pageSummarySchema>;

const clickOutcomeSchema = z.object({
  clicked: z.boolean(),
  errors: z.array(z.string()).default([]),
  heading: z.string().default(""),
  href: z.string().default(""),
  navigated: z.boolean().default(false),
});

export type ClickOutcome = z.infer<typeof clickOutcomeSchema>;

/**
 * The control that sends the whole application. "Apply" alone counts: on a
 * one-page board it is the submit, and a description page's Apply was handled
 * before any of this runs.
 */
const submitControl =
  /^(?:submit(?: application| my application| now)?|send(?: my)? application|apply(?: now)?|finish|complete(?: my)? application)$/iu;

/** The control that moves a multi-page form to its next page. */
const advanceControl =
  /^(?:save (?:and|&) (?:continue|next)|continue|next(?: step| page| section)?|proceed|review(?: application| and submit| & submit)?|go to (?:next|review))$/iu;

/**
 * Controls the runner must never choose to move a form forward: they go
 * backwards, open something else, sign in, or touch attachments and sections
 * that other steps own. Checked before and after the model answers.
 */
const deniedControl =
  /back|previous|cancel|sign ?in|log ?in|sign ?out|log ?out|sign ?up|register|create account|apply with|autofill|attach|upload|browse|\badd\b|remove|delete|edit|clear|dropbox|google ?drive|enter manually|skip|help|privacy|cookie|terms|menu|search|share|save (?:for later|draft|job|and exit)|withdraw|exit|close|dismiss/iu;

export type NextStep =
  | {
      action: "advance" | "submit";
      control: PageControl;
      via: "heuristic" | "model";
    }
  | { action: "stuck"; controls: string[]; via: "heuristic" | "model" };

/** The forward controls a page offers, by the wording the page uses. */
function classifyControls(controls: PageControl[]) {
  const candidates = controls.filter(
    (control) => !control.disabled && !deniedControl.test(control.text)
  );
  return {
    advance: candidates.filter((control) => advanceControl.test(control.text)),
    candidates,
    submit: candidates.filter((control) => submitControl.test(control.text)),
  };
}

const decisionSchema = z.object({
  action: z.enum(["advance", "submit", "stuck"]),
  index: z.number().int().optional(),
  why: z.string().optional(),
});

/**
 * Which control moves the application forward, or whether this page is the
 * one whose control sends it.
 *
 * Code decides when the page is unambiguous: only a submit control, or only
 * an advance control. When both are present, or neither wording matches, the
 * model is asked once, over the page's heading, step indicator, and the
 * numbered control texts, and its answer is checked against the same list:
 * an index that is out of range, disabled, or on the deny list is treated as
 * no answer. The model never sees a value and never clicks.
 */
export async function decideNextStep(summary: PageSummary): Promise<NextStep> {
  const { advance, candidates, submit } = classifyControls(summary.controls);
  const first = <T>(items: T[]): T | undefined => items[0];
  const onlySubmit = first(submit);
  const onlyAdvance = first(advance);
  if (onlySubmit && advance.length === 0) {
    return { action: "submit", control: onlySubmit, via: "heuristic" };
  }
  if (onlyAdvance && submit.length === 0) {
    return { action: "advance", control: onlyAdvance, via: "heuristic" };
  }
  const names = candidates.map((control) => control.text);
  if (candidates.length === 0) {
    return { action: "stuck", controls: names, via: "heuristic" };
  }
  const decision = await askModel(summary, candidates).catch(() => undefined);
  const chosen =
    decision?.index === undefined
      ? undefined
      : candidates.find((control) => control.index === decision.index);
  if (decision && chosen && decision.action !== "stuck") {
    return { action: decision.action, control: chosen, via: "model" };
  }
  return { action: "stuck", controls: names, via: "model" };
}

async function askModel(summary: PageSummary, candidates: PageControl[]) {
  const { text } = await generateText({
    maxOutputTokens: COORDINATOR_MAX_OUTPUT_TOKENS,
    model: chatLanguageModel,
    prompt: [
      "You are looking at one page of an online job application. The form on this page has already been filled in.",
      "Decide which single control moves the application forward.",
      'Return JSON { "action": "advance" | "submit" | "stuck", "index": number, "why": string }.',
      '"advance" moves to the next page of the form without sending it (Save and Continue, Next, Continue, Review).',
      '"submit" is the final control that sends the whole application (Submit, Submit Application).',
      '"stuck" when no listed control does either. Never pick Back, Cancel, Sign in, Apply with LinkedIn, Attach, Add, Remove, or a link away from the form.',
      `Page heading: ${summary.heading || "(none)"}`,
      summary.progress ? `Step indicator: ${summary.progress}` : "",
      `Fillable controls still on the page: ${String(summary.fields)}`,
      `Controls: ${JSON.stringify(candidates.map((control) => ({ index: control.index, text: control.text })))}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const parsed = decisionSchema.safeParse(
    JSON.parse(text.slice(start, end + 1)) as unknown
  );
  return parsed.success ? parsed.data : undefined;
}

/** The page as the decision sees it. */
export async function readPageSummary(
  sessionId: string
): Promise<PageSummary | undefined> {
  const response = await browserProvider.executePlaywright(sessionId, {
    code: collectPageControlsCode,
  });
  const parsed = pageSummarySchema.safeParse(response.result);
  if (parsed.success) return parsed.data;
  applicationExecutionLog({
    error: (response.error ?? "no result").slice(0, 300),
    event: "runner.script_failed",
    script: "page_controls",
    success: response.success,
  });
  return undefined;
}

/** Clicks one numbered control and reports where the page went. */
export async function clickControl(
  sessionId: string,
  control: PageControl
): Promise<ClickOutcome> {
  const response = await browserProvider.executePlaywright(sessionId, {
    code: clickControlCode(control.index),
    timeoutSec: 45,
  });
  const parsed = clickOutcomeSchema.safeParse(response.result);
  if (parsed.success) return parsed.data;
  return {
    clicked: false,
    errors: [(response.error ?? "the browser returned nothing").slice(0, 200)],
    heading: "",
    href: "",
    navigated: false,
  };
}
