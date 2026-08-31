import { env } from "@/lib/env";
import { jobCardFilename, type GoForayJobCard } from "./job-cards";

const JOB_CARD_PNG_PATH = "/api/job-card-png";

/** Eve cannot import `next/og`, so Linq asks the Next.js route to paint the PNG. */
export async function renderJobCardPng(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  try {
    const response = await fetch(
      new URL(JOB_CARD_PNG_PATH, env.BETTER_AUTH_URL),
      {
        body: JSON.stringify({ card, index, total }),
        headers: {
          "content-type": "application/json",
          "x-job-card-secret": env.BETTER_AUTH_SECRET,
        },
        method: "POST",
      }
    );
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) return undefined;
    return { bytes, filename: jobCardFilename(card) };
  } catch {
    return undefined;
  }
}
