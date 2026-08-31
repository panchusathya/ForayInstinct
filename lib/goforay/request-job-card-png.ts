import { env } from "@/lib/env";
import { jobCardFilename, type GoForayJobCard } from "./job-cards";

const JOB_CARD_PNG_PATH = "/api/job-card-png";

/**
 * Eve's channels run in a separate Nitro bundle that cannot resolve `next/og`,
 * so Linq asks the Next.js route to paint the PNG.
 *
 * `BETTER_AUTH_URL` is the right base: Vercel deployment protection on this
 * project is `all_except_custom_domains`, so the production custom domain is
 * the only host a server-to-server call reaches. `VERCEL_URL` and
 * `VERCEL_PROJECT_PRODUCTION_URL` are both `*.vercel.app` and answer with the
 * SSO challenge instead of the image.
 */
export async function renderJobCardPng(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  const endpoint = new URL(JOB_CARD_PNG_PATH, env.BETTER_AUTH_URL);
  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ card, index, total }),
      headers: {
        "content-type": "application/json",
        "x-job-card-secret": env.BETTER_AUTH_SECRET,
      },
      method: "POST",
    });
    if (!response.ok) {
      // The caller still posts the text card, so this log is the only trace a
      // candidate got text instead of an image. Report the status: a 401 means
      // the shared secret diverged, a 404 that the route did not deploy, and
      // an SSO redirect that the base URL is not the custom domain.
      console.warn("[goforay] job-card PNG route rejected the request", {
        company: card.company,
        endpoint: endpoint.origin,
        status: response.status,
      });
      return undefined;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      console.warn("[goforay] job-card PNG route returned an empty body", {
        company: card.company,
        endpoint: endpoint.origin,
      });
      return undefined;
    }
    return { bytes, filename: jobCardFilename(card) };
  } catch (error) {
    console.warn("[goforay] job-card PNG route unreachable", {
      company: card.company,
      endpoint: endpoint.origin,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
