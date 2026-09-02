import { generateText } from "ai";
import { z } from "zod";
import { chatLanguageModel } from "@/lib/model-config";
import { COORDINATOR_MAX_OUTPUT_TOKENS } from "@/lib/model-request";
import type { VisibleFormField } from "@/lib/application-runner/form-map";

const helperSchema = z.object({
  blocker: z.string().optional(),
  fills: z
    .array(z.object({ selector: z.string(), value: z.string() }))
    .default([]),
});

/**
 * One bounded text call for leftover required fields. DOM dump only — never
 * screenshots, never a tool loop.
 */
export async function suggestUnmappedFills(input: {
  answers?: string;
  fields: VisibleFormField[];
  profileSummary: string;
}): Promise<z.infer<typeof helperSchema>> {
  if (input.fields.length === 0) return { fills: [] };
  const { text } = await generateText({
    model: chatLanguageModel,
    maxOutputTokens: COORDINATOR_MAX_OUTPUT_TOKENS,
    prompt: [
      "Map leftover ATS form fields to values from the candidate profile.",
      "Return JSON { fills: [{ selector, value }], blocker?: string }.",
      "If a required field cannot be answered, set blocker to the question text only, with no Needs prefix.",
      "Never invent a password, SSN, or date of birth.",
      `Profile: ${input.profileSummary}`,
      input.answers ? `Candidate answers: ${input.answers}` : "",
      `Fields: ${JSON.stringify(input.fields)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const parsed = helperSchema.safeParse(parseJsonObject(text));
  return parsed.success ? parsed.data : { fills: [] };
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
