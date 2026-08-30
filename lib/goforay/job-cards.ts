import { z } from "zod";

/** One role shown to a candidate. JuiceBox cards have a posting id; Exa leads do not. */
export const goForayJobCardSchema = z.object({
  company: z.string(),
  location: z.string(),
  posting_id: z.string().optional(),
  reasons: z.array(z.string()),
  title: z.string(),
  url: z.string(),
});

export type GoForayJobCard = z.infer<typeof goForayJobCardSchema>;

/** Plain-text card used on SMS and as the iMessage fallback. Always includes the apply URL. */
export function renderGoForayJobCard(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  const heading = [
    `${index}/${total}  ${card.title} · ${card.company}`,
    card.location,
    ...card.reasons.slice(0, 2).map((reason) => `· ${reason}`),
  ]
    .filter(Boolean)
    .join("\n")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .toLowerCase();
  return [heading, card.url, `reply "apply ${index}" to apply`]
    .filter(Boolean)
    .join("\n");
}

export function jobCardFilename(card: GoForayJobCard) {
  const company =
    card.company.toLowerCase().trim().replaceAll(/\s+/gu, "-") || "role";
  return `${company.slice(0, 80)}-role.png`;
}
