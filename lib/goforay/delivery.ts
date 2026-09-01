import { stripKernelLiveViewLinks } from "@/lib/goforay/kernel-links";

const urlPattern = /(https?:\/\/[^\s<]+)/giu;
const sentencePattern = /(?<=[.!?])\s+(?=[a-z0-9])/giu;

export type CandidateReaction = "heart" | "laugh";

/**
 * The model does not reliably reproduce the exact token it is told to emit:
 * `{{react.heat}}` reached a candidate as visible text because the previous
 * pattern accepted only `[[react:heart]]` at the very end of the message. So
 * every directive below is matched tolerantly: either bracket family, either
 * separator, and the spellings the model actually reaches for.
 */
const reactionSynonyms = new Map<string, CandidateReaction>([
  ["heart", "heart"],
  ["hearts", "heart"],
  ["heat", "heart"],
  ["love", "heart"],
  ["laugh", "laugh"],
  ["laughing", "laugh"],
  ["haha", "laugh"],
  ["lol", "laugh"],
]);

const reactionPattern = /[[{]{2}\s*react\s*[.:=]\s*([a-z]+)\s*[\]}]{2}/giu;

/**
 * The one case a candidate is given the browser's live view: a CAPTCHA or an
 * identity check only they can complete in the page. Hidden like a reaction,
 * so it never renders.
 */
const takeoverPattern = /[[{]{2}\s*takeover\s*[\]}]{2}/iu;
const takeoverStripPattern = /\s*[[{]{2}\s*takeover\s*[\]}]{2}\s*/giu;

/**
 * Anything else shaped like a transport directive: a known directive name, or
 * a bare `word:word` / `word.word` with no spaces inside doubled brackets.
 * Deliberately narrow, so ordinary candidate prose that happens to contain a
 * brace is left alone.
 */
const directivePattern =
  /[[{]{2}\s*(?:react[^\s\]}]*|takeover[^\s\]}]*|[a-z_]+\s*[.:=]\s*[a-z0-9_-]+)\s*[\]}]{2}/giu;

/**
 * Removes every transport directive, recognised or not. A directive the
 * channel cannot act on is deleted rather than transmitted: printing one to a
 * candidate is always worse than dropping the reaction it asked for.
 */
export function stripTransportDirectives(value: string) {
  return value
    .replaceAll(reactionPattern, "")
    .replaceAll(directivePattern, "")
    .replaceAll(/[^\S\n]{2,}/gu, " ")
    .replaceAll(/[^\S\n]+\n/gu, "\n")
    .trim();
}

function detectReaction(value: string): CandidateReaction | undefined {
  for (const match of value.matchAll(reactionPattern)) {
    const found = reactionSynonyms.get((match[1] ?? "").toLowerCase());
    if (found) return found;
  }
  return undefined;
}

/**
 * Last-mile guardrail for candidate text. The prompt remains the primary
 * author, but a transport should never surface a tool envelope, a JSON
 * object, or an internal directive as though it were a human response.
 */
export function formatCandidateDelivery(value: string): {
  bubbles: string[];
  reaction?: CandidateReaction;
} {
  const reaction = detectReaction(value);
  const takeover = takeoverPattern.test(value);
  // A takeover marker stands between ideas, so it leaves the break behind
  // rather than closing the gap the way an inert directive does.
  let text = stripTransportDirectives(
    value.replaceAll(takeoverStripPattern, "\n")
  );
  text = unwrapMachineEnvelope(text);
  if (!takeover) text = stripKernelLiveViewLinks(text);
  text = lowercaseProse(text.replaceAll("—", "-").replaceAll("–", "-"));
  const pieces = splitBubbles(text);
  return { bubbles: pieces.slice(0, 5), ...(reaction ? { reaction } : {}) };
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

function splitBubbles(value: string) {
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!normalized) return [];
  const candidates = normalized
    .split(/\n\s*\n|\n(?=[•*-]\s)/u)
    .flatMap((piece) => splitLongPiece(piece.trim()))
    .filter(Boolean);
  if (candidates.length <= 5) return candidates;
  // Preserve the beginning and collapse overflow into the fifth natural bubble
  // rather than transmitting a sixth message while the candidate is waiting.
  return [
    ...candidates.slice(0, 4),
    candidates.slice(4).join(" ").slice(0, 600).trim(),
  ];
}

function splitLongPiece(value: string) {
  if (value.length <= 360) return [value];
  const sentences = value.split(sentencePattern);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = `${current}${current ? " " : ""}${sentence}`;
    if (next.length > 360 && current) {
      pieces.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
