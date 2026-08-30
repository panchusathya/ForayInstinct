/**
 * Conservative extraction of facts the candidate stated in their own words.
 * Does not infer EEO answers, secrets, or ATS fields they did not say.
 */

const captureKeyPrefix = "capture.";

const factPatterns: readonly {
  readonly key: string;
  readonly match: RegExp;
}[] = [
  {
    key: "stated_name",
    match:
      /\b(?:[Mm]y name is|[Ii] am|[Ii]'m)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/u,
  },
  {
    key: "preferred_name",
    match: /\b(?:[Cc]all me|[Ii] go by)\s+([A-Z][a-z]+)\b/u,
  },
  {
    key: "location",
    match:
      /\b(?:[Ii] live in|[Ii]'m based in|[Ii] am based in|[Ii]'m in|[Ii] am in)\s+([A-Za-z]+(?:[\s,]+(?!and\b|or\b|but\b|so\b|then\b|where\b|when\b|if\b|targeting\b)[A-Za-z]+){0,3})\b/u,
  },
  {
    key: "work_authorization",
    match:
      /\b(?:i(?:'m| am) a?\s*)?(us citizen|u\.s\. citizen|green card holder|permanent resident|need(?:s)? sponsorship|do not need sponsorship|don't need sponsorship)\b/iu,
  },
  {
    key: "earliest_start",
    match:
      /\b(?:i can start|available|start date is)\s+(asap|immediately|now)\b/iu,
  },
  {
    key: "target_role",
    match:
      /\b(?:i(?:'m| am) (?:looking for|targeting|open to)|target role is)\s+(?:a |an )?([A-Za-z][A-Za-z0-9+-]*(?:\s+(?!and\b|or\b|but\b|so\b|then\b|targeting\b|looking\b)[A-Za-z][A-Za-z0-9+-]*){0,3})\b/iu,
  },
  {
    key: "compensation_target",
    match:
      /\b(?:i want|targeting|looking for|comp target(?: is)?)\s+(\$?\d{2,3}(?:,\d{3})?(?:k|K)?(?:\s*(?:to|-|–)\s*\$?\d{2,3}(?:,\d{3})?(?:k|K)?)?)\b/u,
  },
];

export function isInternalMemoryKey(key: string) {
  return key.startsWith(captureKeyPrefix);
}

export function extractStatedFacts(text: string) {
  const facts: { key: string; value: string }[] = [];
  for (const pattern of factPatterns) {
    const matched = pattern.match.exec(text);
    const value = matched?.[1]?.replace(/\s+/gu, " ").trim();
    if (!value) continue;
    facts.push({ key: pattern.key, value: normalizeFact(pattern.key, value) });
  }
  return facts;
}

export function userMessageTexts(
  messages: readonly {
    readonly content: unknown;
    readonly role: string;
  }[]
) {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    return textParts(message.content);
  });
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (!isTextPart(part)) continue;
    const trimmed = part.text.trim();
    if (trimmed) texts.push(trimmed);
  }
  return texts;
}

function isTextPart(part: unknown): part is { readonly text: string } {
  if (typeof part !== "object" || part === null) return false;
  return (
    Reflect.get(part, "type") === "text" &&
    typeof Reflect.get(part, "text") === "string"
  );
}

function normalizeFact(key: string, value: string) {
  if (key === "work_authorization") {
    const lower = value.toLowerCase();
    if (lower.includes("citizen")) return "us_citizen";
    if (lower.includes("green card") || lower.includes("permanent resident")) {
      return "us_permanent_resident";
    }
    if (lower.includes("do not") || lower.includes("don't")) {
      return "no_sponsorship";
    }
    return "requires_sponsorship";
  }
  if (key === "earliest_start") return "immediately";
  return value.replace(/[.,;:]+$/u, "");
}
