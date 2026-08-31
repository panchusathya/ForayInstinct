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
import {
  employerDomainFromUrl,
  fetchEmployerLogo,
  logoPixels,
} from "./card-logo";
import {
  brandFromPixels,
  paletteFor,
  seededPaletteFor,
  type CardPalette,
} from "./card-palette";
import { jobCardFilename, jobCardView, type GoForayJobCard } from "./job-cards";

/* oxlint-disable next/no-img-element -- ImageResponse/Satori paints <img>; next/image is not available here. */

/**
 * Portrait 4:5 on a deliberately narrow canvas. iMessage scales an image to the
 * bubble width (~270pt), so the canvas width sets how large text renders: at
 * 900px that factor is 0.30, and the old 1200×562 landscape card put reason
 * text on screen at ~7pt, which is why it had to be opened to be read. Every
 * size below is chosen so the smallest text clears 8pt in the bubble.
 */
const CARD_WIDTH = 900;
/** Never wider than square, and portrait once the content needs the room. */
const CARD_MIN_HEIGHT = 900;
const CARD_MAX_HEIGHT = 1180;
const PAD = 48;
const TILE = 88;

const FONT_TITLE = 60; // 18pt
const FONT_COMPANY = 42; // 12.6pt
const FONT_META = 36; // 10.8pt
const FONT_REASON = 36; // 10.8pt
const FONT_FOOTER = 28; // 8.4pt
const FONT_SOURCE = 24; // 7.2pt, all-caps tracking

export async function renderJobCardPng(
  card: GoForayJobCard,
  index: number,
  total: number
) {
  try {
    const logo = await fetchEmployerLogo(card.url);
    const view = jobCardView(card, index, total);
    const response = new ImageResponse(
      <JobCardOg
        logoSrc={logoDataUri(logo)}
        palette={cardPalette(card, logo)}
        view={view}
      />,
      { height: cardPngHeight(view, Boolean(logo)), width: CARD_WIDTH }
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

const USABLE_WIDTH = CARD_WIDTH - PAD * 2;
/** Mixed-case advance for the bundled Geist face, measured against renders. */
const GLYPH_WIDTH_RATIO = 0.52;

function wrappedLines(text: string, fontSize: number) {
  if (!text) return 0;
  const perLine = Math.max(
    1,
    Math.floor(USABLE_WIDTH / (fontSize * GLYPH_WIDTH_RATIO))
  );
  return Math.max(1, Math.ceil(text.length / perLine));
}

/**
 * Height from the content, because satori clips overflow rather than growing and
 * a fixed tall canvas leaves a dead gap above the footer on every short card.
 *
 * The estimate this replaces was wrong in the same direction everywhere — it
 * gave a 52px title 56px of budget against ~69px for a single line — and only
 * survived because unaccounted bottom padding absorbed the drift. These figures
 * are the real line heights set in the JSX below, so they have to move together.
 */
function cardPngHeight(view: ReturnType<typeof jobCardView>, hasLogo: boolean) {
  const header = Math.max(
    hasLogo ? TILE : 0,
    FONT_COMPANY * 1.25 + (view.sourceLabel ? 6 + FONT_SOURCE * 1.25 : 0)
  );
  const title = 44 + wrappedLines(view.title, FONT_TITLE) * FONT_TITLE * 1.15;
  const meta = view.meta
    ? 22 + wrappedLines(view.meta, FONT_META) * FONT_META * 1.25
    : 0;
  const reasons = view.reasons.length
    ? 36 +
      20 * (view.reasons.length - 1) +
      view.reasons.reduce(
        (total, reason) =>
          total + wrappedLines(reason, FONT_REASON) * FONT_REASON * 1.3,
        0
      )
    : 0;
  // paddingTop + rule + footer row + gap + hint row.
  const footer = 24 + 2 + FONT_FOOTER * 1.25 + 14 + FONT_FOOTER * 1.25;
  const content = PAD * 2 + header + title + meta + reasons + footer;
  // Breathing room above the rule, plus slack for a wrap the estimate missed.
  return Math.round(
    Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, content * 1.08 + 40))
  );
}

/**
 * The employer's own colour when the favicon can be read, otherwise a colour
 * seeded from the employer. Every ATS and aggregator host has no employer
 * favicon at all, so the seeded path is the common case rather than an edge one
 * — and without it every card renders in the same green.
 */
function cardPalette(
  card: GoForayJobCard,
  logo: Awaited<ReturnType<typeof fetchEmployerLogo>>
): CardPalette {
  const pixels = logo ? logoPixels(logo) : undefined;
  if (pixels) {
    const sampled = paletteFor(brandFromPixels(pixels));
    if (sampled.branded) return sampled;
  }
  return seededPaletteFor(
    employerDomainFromUrl(card.url) || card.company || card.url
  );
}

/**
 * Satori throws on WebP (`u2 is not iterable`), which would lose the whole card
 * over a logo, so only formats it actually paints are embedded.
 */
function logoDataUri(logo: Awaited<ReturnType<typeof fetchEmployerLogo>>) {
  if (!logo) return undefined;
  if (
    !/^image\/(?:png|apng|x-png|jpeg|jpg|gif|x-icon|vnd\.microsoft\.icon)\b/iu.test(
      logo.contentType
    )
  )
    return undefined;
  return `data:${logo.contentType};base64,${logo.bytes.toString("base64")}`;
}

function JobCardOg({
  logoSrc,
  palette,
  view,
}: {
  logoSrc?: string;
  palette: CardPalette;
  view: ReturnType<typeof jobCardView>;
}) {
  return (
    <div
      style={{
        // Hex stops only: satori parses no var(), oklch() or color-mix().
        backgroundImage: `linear-gradient(160deg, ${palette.groundFrom} 0%, ${palette.ground} 52%, ${palette.groundTo} 100%)`,
        color: palette.ink,
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        padding: PAD,
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 24 }}>
        {logoSrc ? (
          <div
            style={{
              alignItems: "center",
              background: "#ffffff",
              borderRadius: 18,
              display: "flex",
              flexShrink: 0,
              height: TILE,
              justifyContent: "center",
              width: TILE,
            }}
          >
            <img
              alt=""
              height={64}
              src={logoSrc}
              style={{ objectFit: "contain" }}
              width={64}
            />
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{ display: "flex", fontSize: FONT_COMPANY, fontWeight: 600 }}
          >
            {view.company}
          </div>
          {view.sourceLabel ? (
            <div
              style={{
                color: palette.muted,
                display: "flex",
                fontSize: FONT_SOURCE,
                letterSpacing: 2,
                marginTop: 6,
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
          flexGrow: 1,
          justifyContent: "center",
          paddingBottom: 24,
          paddingTop: 24,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: FONT_TITLE,
            fontWeight: 600,
            lineHeight: 1.15,
          }}
        >
          {view.title}
        </div>
        {view.meta ? (
          <div
            style={{
              color: palette.muted,
              display: "flex",
              fontSize: FONT_META,
              marginTop: 22,
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
              gap: 20,
              marginTop: 36,
            }}
          >
            {view.reasons.map((reason) => (
              <div
                key={reason}
                style={{ alignItems: "flex-start", display: "flex", gap: 18 }}
              >
                <div
                  style={{
                    background: palette.accent,
                    borderRadius: 3,
                    flexShrink: 0,
                    height: 12,
                    marginTop: 14,
                    width: 12,
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    fontSize: FONT_REASON,
                    lineHeight: 1.3,
                  }}
                >
                  {reason}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div
        style={{
          borderTop: `2px solid ${palette.accent}`,
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          paddingTop: 24,
        }}
      >
        <div
          style={{
            color: palette.muted,
            display: "flex",
            fontSize: FONT_FOOTER,
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex" }}>{view.footerPosition}</div>
          <div style={{ display: "flex" }}>{view.via}</div>
        </div>
        <div
          style={{
            color: palette.ink,
            display: "flex",
            fontSize: FONT_FOOTER,
            justifyContent: "center",
            marginTop: 14,
            width: "100%",
          }}
        >
          {view.applyHint}
        </div>
      </div>
    </div>
  );
}
