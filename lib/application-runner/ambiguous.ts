import { generateText } from "ai";
import { z } from "zod";
import { chatLanguageModel } from "@/lib/model-config";
import { COORDINATOR_MAX_OUTPUT_TOKENS } from "@/lib/model-request";
import type { VisibleFormField } from "@/lib/application-runner/form-map";

const helperSchema = z.object({
  /** The single-blocker shape older prompts produced; folded into `blockers`. */
  blocker: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  fills: z
    .array(z.object({ selector: z.string(), value: z.string() }))
    .default([]),
});

/**
 * One bounded text call for leftover required fields. DOM dump only — never
 * screenshots, never a tool loop.
 *
 * It is asked for everything at once: a fill for every field the profile or
 * the candidate's answers state, and the question text of every field it
 * cannot answer. One blocker per round is how a candidate ended up answering
 * five questions across five turns while the coordinator burned its budget.
 */
export async function suggestUnmappedFills(input: {
  answers?: string;
  fields: VisibleFormField[];
  profileSummary: string;
}): Promise<{
  blockers: string[];
  fills: { selector: string; value: string }[];
}> {
  if (input.fields.length === 0) return { blockers: [], fills: [] };
  const { text } = await generateText({
    model: chatLanguageModel,
    maxOutputTokens: COORDINATOR_MAX_OUTPUT_TOKENS,
    prompt: [
      "Map leftover ATS form fields to values from the candidate profile and the candidate's answers.",
      "Return JSON { fills: [{ selector, value }], blockers: string[] }.",
      "Fill every field the profile or the answers state. For a field with options, value must be one of its options.",
      "Put the question text of every required field you cannot answer in blockers, with no Needs prefix. Never guess a value: a blocker is always better than an invented answer.",
      "Never invent a password, SSN, or date of birth.",
      `Profile:\n${input.profileSummary}`,
      input.answers ? `Candidate answers:\n${input.answers}` : "",
      `Fields: ${JSON.stringify(input.fields)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const parsed = helperSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) return { blockers: [], fills: [] };
  return {
    blockers: [
      ...parsed.data.blockers,
      ...(parsed.data.blocker ? [parsed.data.blocker] : []),
    ],
    fills: parsed.data.fills,
  };
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value;
  } catch {
    return {};
  }
}
