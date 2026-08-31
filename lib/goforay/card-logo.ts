import { decode as decodePng, type DecodedPng } from "fast-png";

const GOOGLE_S2 = "https://www.google.com/s2/favicons?domain={domain}&sz=256";
const FETCH_TIMEOUT_MS = 4000;
const HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const BAD_TLDS = new Set([
  "local",
  "internal",
  "localhost",
  "lan",
  "home",
  "test",
]);

/**
 * Applicant tracking systems: the employer's own posting, served by a vendor.
 * Their favicon is the vendor's, but the posting itself is the real thing, so
 * relevance treats these as first-class while logo lookup still skips them.
 */
const ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "smartrecruiters.com",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "oraclecloud.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "bamboohr.com",
  "workable.com",
  "breezy.hr",
  "paylocity.com",
  "rippling.com",
  "pinpointhq.com",
] as const;

/**
 * Aggregators and scrapers. They restate a posting that lives on an ATS, often
 * behind a sign-in wall, so a card should link the ATS instead.
 */
const AGGREGATOR_HOSTS = [
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "builtin.com",
  "wellfound.com",
  "angel.co",
  "dice.com",
  "simplyhired.com",
  "monster.com",
  "talent.com",
  "adzuna.com",
  "jooble.org",
  "otta.com",
  "lensa.com",
  "startup.jobs",
  "remoterocketship.com",
  "levels.fyi",
] as const;

export function sanitizeHostname(raw: string) {
  let host = raw.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  host =
    host
      .split("@")
      .at(-1)
      ?.split(":")[0]
      ?.replace(/^\./u, "")
      .replace(/\.$/u, "") ?? "";
  host = host.replace(/^www\./u, "");
  if (!host || !HOST_RE.test(host)) return "";
  const tld = host.split(".").at(-1) ?? "";
  if (BAD_TLDS.has(tld)) return "";
  const labels = host.split(".");
  if (labels.length === 4 && labels.every((label) => /^\d+$/u.test(label)))
    return "";
  return host;
}

function matchesSuffix(host: string, suffixes: readonly string[]) {
  const value = host.toLowerCase().replace(/^www\./u, "");
  return suffixes.some(
    (suffix) => value === suffix || value.endsWith(`.${suffix}`)
  );
}

export function isAtsHost(host: string) {
  return matchesSuffix(host, ATS_HOSTS);
}

export function isAggregatorHost(host: string) {
  return matchesSuffix(host, AGGREGATOR_HOSTS);
}

/** Hosts whose favicon is the vendor, not the employer. */
export function isAtsOrAggregator(host: string) {
  return isAtsHost(host) || isAggregatorHost(host);
}

export function employerDomainFromUrl(url: string) {
  const host = sanitizeHostname(url);
  if (!host || isAtsOrAggregator(host)) return "";
  return host;
}

function googleFaviconUrl(domain: string) {
  const host = sanitizeHostname(domain);
  if (!host) return undefined;
  return GOOGLE_S2.replace("{domain}", encodeURIComponent(host));
}

export async function fetchEmployerLogo(
  url: string,
  { signal }: { signal?: AbortSignal } = {}
) {
  const domain = employerDomainFromUrl(url);
  const faviconUrl = googleFaviconUrl(domain);
  if (!faviconUrl) return undefined;
  try {
    const response = await fetch(faviconUrl, {
      redirect: "follow",
      signal: AbortSignal.any(
        signal
          ? [signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]
          : [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
      ),
    });
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) return undefined;
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "image/png",
      domain,
    };
  } catch {
    return undefined;
  }
}

/**
 * RGBA pixels from a favicon, for `brandFromPixels`.
 *
 * PNG only. Google's favicon service answers `sz=256` with PNG, and the other
 * formats a host might serve are either undecodable here (SVG) or not worth a
 * second decoder (ICO, GIF) — callers fall back to a seeded colour instead.
 * `fast-png` is pure JS, so this stays safe in a serverless bundle.
 */
export function logoPixels(logo: { bytes: Buffer; contentType: string }) {
  if (!/^image\/(?:png|apng|x-png)\b/iu.test(logo.contentType))
    return undefined;
  // Trust the magic bytes over the header: hosts mislabel favicons routinely.
  if (!logo.bytes.subarray(0, 8).equals(PNG_MAGIC)) return undefined;
  try {
    const image = decodePng(logo.bytes);
    return toRgba(image);
  } catch {
    return undefined;
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * `brandFromPixels` walks a 4-channel 8-bit buffer, but a PNG may be greyscale,
 * palette-indexed, or 16-bit. Expand whatever came back rather than handing it a
 * stride it would misread as colour.
 */
function toRgba(image: DecodedPng) {
  const { channels, data, depth, height, palette, width } = image;
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  // 16-bit samples scale down; 1/2/4-bit depths are expanded by the decoder.
  const scale = depth === 16 ? 1 / 257 : 1;
  const sample = (offset: number) => Math.round((data[offset] ?? 0) * scale);

  for (let index = 0; index < pixels; index += 1) {
    const target = index * 4;
    if (palette) {
      const entry = palette[data[index] ?? 0] ?? [0, 0, 0];
      rgba[target] = entry[0] ?? 0;
      rgba[target + 1] = entry[1] ?? 0;
      rgba[target + 2] = entry[2] ?? 0;
      rgba[target + 3] = 255;
      continue;
    }
    if (channels === 1 || channels === 2) {
      const grey = sample(index * channels);
      rgba[target] = grey;
      rgba[target + 1] = grey;
      rgba[target + 2] = grey;
      rgba[target + 3] = channels === 2 ? sample(index * 2 + 1) : 255;
      continue;
    }
    rgba[target] = sample(index * channels);
    rgba[target + 1] = sample(index * channels + 1);
    rgba[target + 2] = sample(index * channels + 2);
    rgba[target + 3] = channels === 4 ? sample(index * 4 + 3) : 255;
  }
  return rgba;
}
