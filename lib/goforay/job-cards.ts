import { z } from "zod";

const ROLE_SEARCH_TOOL_NAMES = [
  "find_goforay_roles",
  "find_next_goforay_roles",
] as const;

const MAX_TITLE_CHARS = 64;
const MAX_COMPANY_CHARS = 34;
const MAX_META_CHARS = 58;
const MAX_REASON_CHARS = 62;
const MAX_CARD_REASONS = 2;

/** One role shown to a candidate. JuiceBox cards have a posting id; Exa leads do not. */
export const goForayJobCardSchema = z.object({
  company: z.string(),
  location: z.string(),
  posting_id: z.string().optional(),
  reasons: z.array(z.string()),
  seniority: z.string().optional(),
  source_label: z.string().optional(),
  title: z.string(),
  url: z.string(),
});

export type GoForayJobCard = z.infer<typeof goForayJobCardSchema>;

const roleSearchToolOutputSchema = z.object({
  cards: z.array(goForayJobCardSchema),
});

export const TITLE_COMPANY_SEPARATORS = [
  " at ",
  " @ ",
  " - ",
  " — ",
  " – ",
  " | ",
] as const;

function isRoleSearchToolName(name: string) {
  return (ROLE_SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

export function jobCardsFromToolOutput(output: unknown) {
  const direct = roleSearchToolOutputSchema.safeParse(output);
  if (direct.success) return direct.data.cards;
  if (typeof output === "object" && output !== null && "value" in output) {
    const nested = roleSearchToolOutputSchema.safeParse(output.value);
    if (nested.success) return nested.data.cards;
  }
  return [];
}

export function isVisibleJobCardToolPart(part: {
  output?: unknown;
  toolName?: string;
  type: string;
}) {
  return (
    part.type === "dynamic-tool" &&
    typeof part.toolName === "string" &&
    isRoleSearchToolName(part.toolName) &&
    jobCardsFromToolOutput(part.output).length > 0
  );
}

/** Strip a trailing "at {company}" clause scraped into the headline. */
export function cleanTitle(title: string, company: string) {
  const trimmedTitle = title.trim();
  const trimmedCompany = company.trim();
  if (!trimmedTitle || !trimmedCompany) return trimmedTitle;
  const lowered = trimmedTitle.toLowerCase();
  for (const separator of TITLE_COMPANY_SEPARATORS) {
    const suffix = `${separator}${trimmedCompany}`.toLowerCase();
    if (lowered.endsWith(suffix)) {
      return trimmedTitle
        .slice(0, trimmedTitle.length - suffix.length)
        .replace(/[ ,\-@|—–]+$/u, "");
    }
  }
  return trimmedTitle;
}

function clipCardText(text: string, limit: number) {
  const value = text.split(/\s+/u).join(" ").trim();
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function spacedCaps(text: string) {
  let spaced = "";
  for (const character of text) {
    if (spaced.length > 0) spaced += " ";
    spaced += character;
  }
  return spaced;
}

function applyReplyLine(index: number) {
  return `apply ${String(index)}`;
}

/** Display fields shared by the React card and the PNG renderer. */
export function jobCardView(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  const company = clipCardText(card.company, MAX_COMPANY_CHARS);
  const title = clipCardText(
    cleanTitle(card.title, card.company) || "Role",
    MAX_TITLE_CHARS
  );
  const sourceLabel = clipCardText((card.source_label ?? "").toUpperCase(), 24);
  const meta = clipCardText(
    [card.location, card.seniority].filter(Boolean).join(" · "),
    MAX_META_CHARS
  );
  const reasons = card.reasons
    .slice(0, MAX_CARD_REASONS)
    .map((reason) => clipCardText(reason, MAX_REASON_CHARS))
    .filter(Boolean);
  return {
    applyLabel: `Apply ${String(index)}`,
    applyReply: applyReplyLine(index),
    company,
    footerPosition:
      total > 1 ? `${String(index)} of ${String(total)}` : "open role",
    meta,
    reasons,
    sourceLabel: sourceLabel ? spacedCaps(sourceLabel) : "",
    title,
    via: "via Foray",
  };
}

/** Plain-text card used on SMS and as the iMessage fallback. Always includes the apply URL. */
export function renderGoForayJobCard(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  const view = jobCardView(card, index, total);
  const heading = [
    `${String(index)}/${String(total)}  ${view.title} · ${view.company}`,
    view.meta,
    ...view.reasons.map((reason) => `· ${reason}`),
  ]
    .filter(Boolean)
    .join("\n")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .toLowerCase();
  return [heading, card.url, `reply "${view.applyReply}" to apply`]
    .filter(Boolean)
    .join("\n");
}

export function jobCardFilename(card: GoForayJobCard) {
  const company =
    card.company.toLowerCase().trim().replaceAll(/\s+/gu, "-") || "role";
  return `${company.slice(0, 80)}-role.png`;
}
