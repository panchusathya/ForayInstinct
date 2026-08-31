/**
 * Paints a job card with Satori. `next/og` resolves only inside the Next.js
 * app, so this module may be imported from a route handler and nowhere else.
 *
 * The Eve agent deploys as its own Nitro bundle (`.eve/vercel-services/eve`,
 * a lambda with no `node_modules` and no `@vercel/og` wasm beside it), so an
 * authored channel importing this — by any path, including a deep dynamic
 * `import("next/dist/compiled/@vercel/og/...")` — throws at runtime and
 * silently degrades every card to its text twin. Channels reach the renderer
 * through `request-job-card-png.ts` instead.
 */
import { ImageResponse } from "next/og";
import { fetchEmployerLogo } from "./card-logo";
import { NEUTRAL_PALETTE } from "./card-palette";
import { jobCardFilename, jobCardView, type GoForayJobCard } from "./job-cards";

/* oxlint-disable next/no-img-element -- ImageResponse/Satori paints <img>; next/image is not available here. */

const PAD = 56;
const TILE = 96;
const CARD_PNG_MAX_HEIGHT = 720;

export async function renderJobCardPng(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  try {
    const logo = await fetchEmployerLogo(card.url);
    const view = jobCardView(card, index, total);
    const logoSrc = logo
      ? `data:${logo.contentType};base64,${logo.bytes.toString("base64")}`
      : undefined;
    const height = cardPngHeight(view);
    const response = new ImageResponse(
      <JobCardOg logoSrc={logoSrc} palette={NEUTRAL_PALETTE} view={view} />,
      { height, width: 1200 }
    );
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      filename: jobCardFilename(card),
    };
  } catch (error) {
    // Never drop the role: the caller falls back to the text card. Say why,
    // though — a silent renderer failure is what let two releases ship a text
    // twin on iMessage while everyone believed images were going out.
    console.error("[goforay] job-card PNG render failed", {
      company: card.company,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function cardPngHeight(view: ReturnType<typeof jobCardView>) {
  const bodyTop = PAD + TILE + 40;
  let contentBottom = bodyTop + 56 + 20;
  if (view.meta) contentBottom += 44;
  if (view.reasons.length) contentBottom += 14 + 40 * view.reasons.length;
  const ruleY = contentBottom + 40;
  return Math.min(CARD_PNG_MAX_HEIGHT, ruleY + 20 + 40 + PAD);
}

function JobCardOg({
  logoSrc,
  palette,
  view,
}: {
  logoSrc?: string;
  palette: typeof NEUTRAL_PALETTE;
  view: ReturnType<typeof jobCardView>;
}) {
  return (
    <div
      style={{
        background: palette.ground,
        color: palette.ink,
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        padding: PAD,
        width: "100%",
      }}
    >
      <div style={{ display: "flex", flexDirection: "row", gap: 28 }}>
        {logoSrc ? (
          <div
            style={{
              alignItems: "center",
              background: "#ffffff",
              border: `1px solid ${palette.muted}`,
              borderRadius: 16,
              display: "flex",
              height: TILE,
              justifyContent: "center",
              width: TILE,
            }}
          >
            <img
              alt=""
              height={72}
              src={logoSrc}
              style={{ objectFit: "contain" }}
              width={72}
            />
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingTop: 8,
          }}
        >
          <div style={{ display: "flex", fontSize: 32, fontWeight: 600 }}>
            {view.company}
          </div>
          {view.sourceLabel ? (
            <div
              style={{
                color: palette.muted,
                display: "flex",
                fontSize: 15,
                letterSpacing: 2,
                marginTop: 8,
              }}
            >
              {view.sourceLabel}
            </div>
          ) : null}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          fontSize: 52,
          fontWeight: 600,
          marginTop: 40,
        }}
      >
        {view.title}
      </div>
      {view.meta ? (
        <div
          style={{
            color: palette.muted,
            display: "flex",
            fontSize: 25,
            marginTop: 20,
          }}
        >
          {view.meta}
        </div>
      ) : null}
      {view.reasons.length ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginTop: 28,
          }}
        >
          {view.reasons.map((reason) => (
            <div
              key={reason}
              style={{ alignItems: "center", display: "flex", gap: 16 }}
            >
              <div
                style={{
                  background: palette.accent,
                  height: 10,
                  width: 10,
                }}
              />
              <div style={{ display: "flex", fontSize: 23 }}>{reason}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div
        style={{
          borderTop: `1px solid ${palette.accent}`,
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          paddingTop: 20,
        }}
      >
        <div
          style={{
            color: palette.muted,
            display: "flex",
            fontSize: 20,
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex" }}>{view.footerPosition}</div>
          <div style={{ display: "flex" }}>{view.via}</div>
        </div>
        <div
          style={{
            color: palette.muted,
            display: "flex",
            fontSize: 20,
            justifyContent: "center",
            marginTop: 8,
            width: "100%",
          }}
        >
          {`reply "${view.applyReply}"`}
        </div>
      </div>
    </div>
  );
}
