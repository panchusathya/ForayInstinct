const reactionPattern = /\s*\[\[react:(heart|laugh)\]\]\s*$/iu;
const urlPattern = /(https?:\/\/[^\s<]+)/giu;

export type CandidateReaction = "heart" | "laugh";

/**
 * Last-mile guardrail for candidate text. The prompt remains the primary
 * author, but a transport should never surface a tool envelope or a JSON
 * object as though it were a human response.
 */
export function formatCandidateDelivery(value: string): {
  bubbles: string[];
  reaction?: CandidateReaction;
} {
  const reaction = reactionPattern.exec(value)?.[1] as
    | CandidateReaction
    | undefined;
  let text = value.replace(reactionPattern, "").trim();
  text = unwrapMachineEnvelope(text);
  text = lowercaseProse(text.replaceAll("—", "-").replaceAll("–", "-"));
  return { bubbles: text ? [text] : [], ...(reaction ? { reaction } : {}) };
}

function unwrapMachineEnvelope(value: string) {
  const fenced =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value)?.[1] ?? value;
  const background = /^(?:background task[^\n]*?(?:result|error):\s*)/iu.test(
    fenced
  )
    ? fenced.replace(/^background task[^\n]*?(?:result|error):\s*/iu, "")
    : fenced;
  try {
    const parsed: unknown = JSON.parse(background);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "text", "content"]) {
        if (typeof record[key] === "string" && record[key].trim())
          return record[key].trim();
      }
    }
  } catch {
    // Ordinary prose is not JSON.
  }
  return background;
}

function lowercaseProse(value: string) {
  return value
    .split(urlPattern)
    .map((part) => (/^https?:\/\//iu.test(part) ? part : part.toLowerCase()))
    .join("");
}
