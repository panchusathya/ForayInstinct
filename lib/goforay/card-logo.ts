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

/** Hosts whose favicon is the vendor, not the employer. */
const ATS_SUFFIXES = [
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

export function isAtsOrAggregator(host: string) {
  const value = host.toLowerCase().replace(/^www\./u, "");
  return ATS_SUFFIXES.some(
    (suffix) => value === suffix || value.endsWith(`.${suffix}`)
  );
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
