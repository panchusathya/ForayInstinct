import { decode, encode } from "fast-png";
import { describe, expect, it } from "vitest";
import { renderJobCardPng } from "@/lib/goforay/card-png";
import { logoPixels } from "@/lib/goforay/card-logo";
import {
  brandFromPixels,
  NEUTRAL_PALETTE,
  paletteFor,
  seededPaletteFor,
} from "@/lib/goforay/card-palette";
import type { GoForayJobCard } from "@/lib/goforay/job-cards";

/**
 * The renderer is mocked out of every other card test, so nothing else pins the
 * output. A layout regression here is invisible to a mock: satori clips
 * overflow rather than growing, and the card is read inside a phone bubble
 * where the canvas width decides whether text is legible at all.
 */

const typical: GoForayJobCard = {
  company: "Ramp",
  location: "New York, NY",
  reasons: ["matches fp&a", "Reporting to the VP of Finance on planning."],
  source_label: "open market",
  title: "Head of FP&A",
  url: "https://jobs.ashbyhq.com/ramp/2f1c9a44-1b2e-4c3d-9e8f-7a6b5c4d3e2f",
};

/** 64-char title, 58-char meta, two 62-char reasons: the clip ceilings. */
const worstCase: GoForayJobCard = {
  company: "Northwestern Mutual Investment Management",
  location: "San Francisco, California, United States (Hybrid, 3 days)",
  reasons: [
    "matches strategic finance and corporate development planning",
    "You will own the annual operating plan and the board model.",
  ],
  source_label: "open market",
  title: "Senior Manager, Strategic Finance and Corporate Development",
  url: "https://example.com/careers/senior-manager-strategic-finance-4821",
};

async function render(card: GoForayJobCard, index = 1, total = 4) {
  const result = await renderJobCardPng(card, index, total);
  expect(result).toBeDefined();
  const bytes = result?.bytes ?? Buffer.alloc(0);
  expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  return decode(bytes);
}

describe("job card png render", () => {
  it("renders square or portrait, never the old landscape", async () => {
    const image = await render(typical);
    expect(image.width).toBe(900);
    // Landscape is what forced the candidate to open the image to read it.
    expect(image.height).toBeGreaterThanOrEqual(image.width);
  }, 60000);

  it("grows for the worst case instead of clipping it", async () => {
    const [typicalImage, worstImage] = await Promise.all([
      render(typical),
      render(worstCase),
    ]);
    expect(worstImage.height).toBeGreaterThan(typicalImage.height);
    expect(worstImage.height).toBeLessThanOrEqual(1180);
  }, 90000);

  it("gives two employers different colours", async () => {
    // Every card used to paint the same hardcoded green.
    const one = seededPaletteFor("ramp.com");
    const two = seededPaletteFor("thetorocompany.com");
    expect(one.ground).not.toBe(two.ground);
    expect(one.ground).not.toBe(NEUTRAL_PALETTE.ground);
  });

  it("keeps every gradient stop readable against the ink", async () => {
    // A ground near the luminance ceiling loses contrast when lightened, so the
    // lifted stop is derived through the guard rather than by a fixed weight.
    const { contrastRatio } = await import("@/lib/goforay/card-palette");
    for (const key of ["acme.io", "stripe.com", "figma.com", "openai.com"]) {
      const palette = seededPaletteFor(key);
      expect(
        contrastRatio(palette.groundFrom, palette.ink)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(palette.groundTo, palette.ink)
      ).toBeGreaterThanOrEqual(4.5);
    }
    const sampled = paletteFor({ primary: "#767676" });
    expect(
      contrastRatio(sampled.groundFrom, sampled.ink)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("samples a logo's own colour when the favicon decodes", async () => {
    const size = 16;
    const data = new Uint8Array(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
      data[index * 4] = 0x1b;
      data[index * 4 + 1] = 0x3a;
      data[index * 4 + 2] = 0x8f;
      data[index * 4 + 3] = 255;
    }
    const png = Buffer.from(
      encode({ channels: 4, data, depth: 8, height: size, width: size })
    );

    const pixels = logoPixels({ bytes: png, contentType: "image/png" });
    expect(pixels).toBeDefined();
    const palette = paletteFor(brandFromPixels(pixels ?? new Uint8Array()));
    expect(palette.branded).toBe(true);
    expect(palette.ground).toBe("#1b3a8f");
  });

  it("skips a logo that is not really a PNG", () => {
    expect(
      logoPixels({ bytes: Buffer.from("<svg/>"), contentType: "image/svg+xml" })
    ).toBeUndefined();
    // Mislabelled bytes are common; the magic number decides.
    expect(
      logoPixels({ bytes: Buffer.from("not a png"), contentType: "image/png" })
    ).toBeUndefined();
  });
});
