/**
 * Deliberately small stand-in for the public-suffix list: the last two labels
 * form the registrable domain unless the "TLD" itself is two labels. Covers
 * the country suffixes ATS hosts actually appear under; a miss only makes the
 * cross-domain detector slightly stricter or looser, it never blocks anything.
 */
const twoPartTlds = new Set([
  "ac.uk",
  "co.in",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.uk",
  "co.za",
  "com.au",
  "com.br",
  "com.hk",
  "com.mx",
  "com.sg",
  "gov.uk",
  "net.au",
  "org.au",
  "org.uk",
]);

/** `www.foo.com` -> `foo.com`; `a.b.co.uk` -> `b.co.uk`. */
export function registrableDomain(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .split(".")
    .filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = twoPartTlds.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Registrable domain of a URL, or undefined for unparseable/hostless URLs. */
export function urlRegistrableDomain(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (!hostname) return undefined;
    return registrableDomain(hostname);
  } catch {
    return undefined;
  }
}
