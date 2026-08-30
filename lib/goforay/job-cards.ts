export type GoForayJobCard = {
  company: string;
  location: string;
  posting_id: string;
  reasons: string[];
  title: string;
};

/** Plain-text equivalent used on SMS, web, and any image delivery failure. */
export function renderGoForayJobCard(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  const lines = [
    `${index}/${total}  ${card.title} · ${card.company}`,
    card.location,
    ...card.reasons.slice(0, 2).map((reason) => `· ${reason}`),
    `reply "apply ${index}" to apply`,
  ].filter(Boolean);
  return lines.join("\n").replaceAll("—", "-").toLowerCase();
}

export function jobCardFilename(card: GoForayJobCard) {
  const company =
    card.company.toLowerCase().trim().replaceAll(/\s+/gu, "-") || "role";
  return `${company.slice(0, 80)}-role.png`;
}
