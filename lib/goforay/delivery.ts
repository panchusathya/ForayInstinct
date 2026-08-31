import { stripKernelLiveViewLinks } from "@/lib/goforay/kernel-links";

const reactionPattern = /\s*\[\[react:(heart|laugh)\]\]\s*$/iu;
/**
 * The one case a candidate is given the browser's live view: a CAPTCHA or an
 * identity check only they can complete in the page. Hidden like `[[react:…]]`,
 * so it never renders.
 */
const takeoverPattern = /\[\[takeover\]\]/iu;
const takeoverStripPattern = /\s*\[\[takeover\]\]\s*/giu;
const urlPattern = /(https?:\/\/[^\s<]+)/giu;
const sentencePattern = /(?<=[.!?])\s+(?=[a-z0-9])/giu;

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
  const takeover = takeoverPattern.test(text);
  text = text.replace(takeoverStripPattern, "\n").trim();
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
