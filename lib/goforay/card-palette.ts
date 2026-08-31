/** Readable card colours from an employer brand, or Foray's own green. */

export const NEUTRAL_GROUND = "#12332c";
export const NEUTRAL_ACCENT = "#4cc38a";
export const LIGHT_GROUND = "#f5f5f3";
export const INK_LIGHT = "#ffffff";
const INK_DARK = "#17211e";

const MAX_GROUND_LUMINANCE = 0.62;
const MIN_CONTRAST = 4.5;
const MIN_ACCENT_CONTRAST = 1.8;

function rgbOf(colour: string) {
  const text = colour.trim().replace(/^#/u, "");
  if (text.length !== 6) return undefined;
  const red = Number.parseInt(text.slice(0, 2), 16);
  const green = Number.parseInt(text.slice(2, 4), 16);
  const blue = Number.parseInt(text.slice(4, 6), 16);
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return undefined;
  }
  return [red, green, blue] as const;
}

function hexOf(rgb: readonly [number, number, number]) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(colour: string) {
  const rgb = rgbOf(colour);
  if (!rgb) return 0;
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

export function contrastRatio(one: string, two: string) {
  const a = relativeLuminance(one);
  const b = relativeLuminance(two);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(one: string, two: string, weight: number) {
  const a = rgbOf(one) ?? ([0, 0, 0] as const);
  const b = rgbOf(two) ?? ([0, 0, 0] as const);
  return hexOf([
    Math.round(a[0] + (b[0] - a[0]) * weight),
    Math.round(a[1] + (b[1] - a[1]) * weight),
    Math.round(a[2] + (b[2] - a[2]) * weight),
  ]);
}

function readableAccent(ground: string, wanted: string, ink: string) {
  if (!wanted) return mix(ground, ink, 0.55);
  let shade = wanted;
  for (const weight of [0, 0.2, 0.35, 0.5, 0.65, 0.8]) {
    shade = mix(wanted, ink, weight);
    if (contrastRatio(ground, shade) >= MIN_ACCENT_CONTRAST) return shade;
  }
  return shade;
}

/**
 * Gradient stops for a ground colour.
 *
 * Lightening a ground that already sits near `MAX_GROUND_LUMINANCE` can push it
 * under the readable threshold: `#767676` clears white ink at 4.54, but mixing
 * 8% white gives `#818181` at 3.90. So walk the weight down until the lifted
 * stop still clears, the same way `readableAccent` walks toward the ink.
 */
function groundStops(ground: string, ink: string) {
  let from = ground;
  for (const weight of [0.1, 0.07, 0.05, 0.03, 0]) {
    from = mix(ground, ink, weight);
    if (contrastRatio(from, ink) >= MIN_CONTRAST) break;
  }
  // Darkening away from the ink never reduces contrast, so it needs no guard.
  const away = relativeLuminance(ground) < 0.4 ? "#000000" : "#ffffff";
  return { groundFrom: from, groundTo: mix(ground, away, 0.28) };
}

export function paletteFor(brand?: { accent?: string; primary?: string }) {
  const primary = brand?.primary ?? "";
  const accent = brand?.accent ?? "";

  if (primary && relativeLuminance(primary) <= MAX_GROUND_LUMINANCE) {
    const ground = primary;
    const ink = relativeLuminance(ground) < 0.4 ? INK_LIGHT : INK_DARK;
    if (contrastRatio(ground, ink) >= MIN_CONTRAST) {
      return {
        accent: readableAccent(ground, accent || primary, ink),
        branded: true,
        ground,
        ...groundStops(ground, ink),
        ink,
        muted: mix(ground, ink, 0.72),
      };
    }
  }

  if (primary && contrastRatio(LIGHT_GROUND, INK_DARK) >= MIN_CONTRAST) {
    return {
      accent: readableAccent(LIGHT_GROUND, primary, INK_DARK),
      branded: true,
      ground: LIGHT_GROUND,
      ...groundStops(LIGHT_GROUND, INK_DARK),
      ink: INK_DARK,
      muted: mix(LIGHT_GROUND, INK_DARK, 0.66),
    };
  }

  return {
    accent: NEUTRAL_ACCENT,
    branded: false,
    ground: NEUTRAL_GROUND,
    ...groundStops(NEUTRAL_GROUND, INK_LIGHT),
    ink: INK_LIGHT,
    muted: mix(NEUTRAL_GROUND, INK_LIGHT, 0.7),
  };
}

export type CardPalette = ReturnType<typeof paletteFor>;

function saturation(rgb: readonly [number, number, number]) {
  const high = Math.max(...rgb);
  const low = Math.min(...rgb);
  return high === 0 ? 0 : (high - low) / high;
}

/** Brand colours from raster pixels, strongest first. Near-white/black dropped. */
export function brandFromPixels(
  data: ArrayLike<number>,
  { count = 2 }: { count?: number } = {}
) {
  const buckets = new Map<
    string,
    { pixels: number; rgb: readonly [number, number, number] }
  >();
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const weight = alpha / 255;
    if (weight < 0.5) continue;
    const flat = [
      Math.round(red * weight + 255 * (1 - weight)),
      Math.round(green * weight + 255 * (1 - weight)),
      Math.round(blue * weight + 255 * (1 - weight)),
    ] as const;
    const quantized = hexOf([
      (flat[0] >> 4) << 4,
      (flat[1] >> 4) << 4,
      (flat[2] >> 4) << 4,
    ]);
    const bucket = buckets.get(quantized);
    if (bucket) bucket.pixels += 1;
    else buckets.set(quantized, { pixels: 1, rgb: flat });
  }

  const total =
    [...buckets.values()].reduce((sum, bucket) => sum + bucket.pixels, 0) || 1;
  const scored = [...buckets.values()]
    .map((bucket) => {
      const colour = hexOf(bucket.rgb);
      const luminance = relativeLuminance(colour);
      if (luminance > 0.9 || luminance < 0.02) return undefined;
      return {
        colour,
        score: saturation(bucket.rgb) * (bucket.pixels / total) ** 0.35,
      };
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.score - left.score);

  const chosen: string[] = [];
  for (const entry of scored) {
    if (chosen.includes(entry.colour)) continue;
    if (chosen.some((taken) => contrastRatio(entry.colour, taken) < 1.3))
      continue;
    chosen.push(entry.colour);
    if (chosen.length >= count) break;
  }

  return {
    accent: chosen[1] ?? "",
    primary: chosen[0] ?? "",
  };
}

/** Stable 32-bit hash, so an employer keeps the same colour between batches. */
function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function hslHex(
  hue: number,
  saturationPercent: number,
  lightnessPercent: number
) {
  const h = ((hue % 360) + 360) % 360;
  const s = saturationPercent / 100;
  const l = lightnessPercent / 100;
  const amplitude = s * Math.min(l, 1 - l);
  const channel = (offset: number) => {
    const k = (offset + h / 30) % 12;
    const value =
      l - amplitude * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(value * 255);
  };
  return hexOf([channel(0), channel(8), channel(4)]);
}

/**
 * A distinct readable colour for an employer we could not sample a logo from —
 * every ATS and aggregator host lands here, so it is the common case, not an
 * edge one. Seeded from the employer key so a role keeps its colour, and run
 * through `paletteFor` so contrast is guaranteed rather than assumed. Held at a
 * dark lightness band that clears white ink across the whole hue circle.
 */
export function seededPaletteFor(employerKey: string) {
  const key = employerKey.trim().toLowerCase();
  if (!key) return NEUTRAL_PALETTE;
  const hash = fnv1a(key);
  const lightness = [24, 25, 26][(hash >>> 12) % 3] ?? 25;
  return paletteFor({
    accent: hslHex((hash % 360) + 32, 70, 62),
    primary: hslHex(hash % 360, 62, lightness),
  });
}

export const NEUTRAL_PALETTE = paletteFor();
