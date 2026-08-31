import { isAggregatorHost, isAtsHost, sanitizeHostname } from "./card-logo";

/**
 * A hard filter over public search hits, between the search response and the
 * card mapping. Public search returns whatever ranks for a query, so without
 * this every hit became a card: a private equity firm's homepage arrived as a
 * "strategic finance role" with a slice of its nav bar as the reason it fit.
 *
 * Deliberately deterministic. Every rejection here is decidable from the URL
 * shape and the title, so a model adds no judgement, would sit on a path the
 * product optimises for immediacy, and would make these outcomes untestable.
 * It would also be reading untrusted scraped text to decide what a candidate
 * sees. Ranking the survivors is where a model would earn its place.
 */

type RoleRejection =
  | "aggregator-host"
  | "generic-title"
  | "landing-page"
  | "not-a-posting"
  | "title-mismatch";

export interface RoleRelevance {
  verdict: "accept" | "reject";
  reason: "ok" | RoleRejection;
  /** Wanted phrases actually found, used as the card's first reason. */
  matched: string[];
}

const STOPWORDS = new Set([
  "a",
  "and",
  "at",
  "for",
  "in",
  "job",
  "jobs",
  "of",
  "opening",
  "openings",
  "position",
  "positions",
  "role",
  "roles",
  "the",
  "to",
]);

/**
 * Titles a hiring team writes for the same work. Without these, a search for
 * "strategic finance" rejects the FP&A and corporate development postings that
 * are exactly what was asked for.
 */
const ROLE_SYNONYMS: Record<string, readonly string[]> = {
  "corporate development": ["corp dev", "m&a", "strategic finance"],
  "investor relations": ["ir", "shareholder relations"],
  "revenue operations": ["revops", "rev ops", "sales operations"],
  "strategic finance": [
    "business finance",
    "corp dev",
    "corporate development",
    "corporate finance",
    "finance & strategy",
    "finance and strategy",
    "financial planning",
    "fp&a",
    "fpa",
    "strategy & finance",
  ],
};

/** Path segments that name a hiring area rather than one posting. */
const JOB_SEGMENTS = new Set([
  "apply",
  "career",
  "careers",
  "job",
  "jobs",
  "opening",
  "openings",
  "opportunities",
  "position",
  "positions",
  "role",
  "roles",
  "vacancies",
  "vacancy",
]);

/** Paths that are a company telling you about itself. */
const NON_POSTING_SEGMENTS = new Set([
  "about",
  "approach",
  "company",
  "contact",
  "founders",
  "investments",
  "news",
  "our-firm",
  "our-team",
  "partners",
  "people",
  "portfolio",
  "press",
  "team",
  "values",
]);

const GENERIC_TITLE_RE =
  /^(?:careers?|jobs?|open (?:roles|positions)|join (?:us|our team)|work (?:with|for) us|our team|about(?: us)?|home|life at .*|.* careers)$/iu;

/** Known ATS posting paths. A match here is proof of a single posting. */
const ATS_POSTING_PATHS: readonly RegExp[] = [
  /\/jobs\/\d+/u, // greenhouse, icims, bamboohr
  /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu, // lever, ashby
  /\/job\/[^/]+/u, // workday, jobvite
  /\/j\/[0-9a-f]{6,}/iu, // workable
  /\/recruiting\/jobs\/details\/\d+/iu, // paylocity
  /\/p\/[^/]+/u, // breezy
  /\/publications\/[^/]+/u, // smartrecruiters
];

const ID_SEGMENT_RE = /^(?:\d+|[0-9a-f-]{8,})$/iu;

/** A subdomain that is itself the job board, so the path need not say so. */
const JOB_SUBDOMAIN_RE = /^(?:jobs?|careers?|apply|boards?|hiring)\./u;

function hasDiscriminator(segment: string) {
  if (ID_SEGMENT_RE.test(segment)) return true;
  // A role slug names one posting: "strategic-finance",
  // "senior-manager-strategic-finance". A bare "careers" does not.
  return segment.split("-").filter(Boolean).length >= 2;
}

function normalizePhrase(value: string) {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The phrases a title must contain, built from the bare role rather than the
 * seniority-prefixed search string, so "senior strategic finance" does not
 * require the word "senior" in the title.
 */
export function relevanceTokens(role: string, seniority?: string) {
  const phrase = normalizePhrase(role);
  if (!phrase) return [];

  const wanted = new Set<string>([phrase]);
  for (const [key, synonyms] of Object.entries(ROLE_SYNONYMS)) {
    if (!phrase.includes(key)) continue;
    for (const synonym of synonyms) wanted.add(synonym);
  }

  // Individual words let "strategic finance analyst" match a title reading
  // "Analyst, Finance". Seniority never becomes a requirement of its own.
  const seniorityWord = normalizePhrase(seniority ?? "");
  for (const word of phrase.split(" ")) {
    if (!STOPWORDS.has(word) && word !== seniorityWord && word.length > 2) {
      wanted.add(word);
    }
  }
  return [...wanted];
}

function matchedIn(haystack: string, wanted: readonly string[]) {
  const value = normalizePhrase(haystack);
  if (!value) return [];
  // Longest first, so a card reports "strategic finance" over "finance".
  return [...wanted]
    .sort((a, b) => b.length - a.length)
    .filter((token) => value.includes(token));
}

function postingShape(url: string): "posting" | RoleRejection {
  const host = sanitizeHostname(url);
  if (!host) return "not-a-posting";
  if (isAggregatorHost(host)) return "aggregator-host";

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "not-a-posting";
  }

  if (isAtsHost(host) && ATS_POSTING_PATHS.some((re) => re.test(path))) {
    return "posting";
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "not-a-posting";
  if (
    segments.some((segment) => NON_POSTING_SEGMENTS.has(segment.toLowerCase()))
  )
    return "landing-page";

  const jobSubdomain = JOB_SUBDOMAIN_RE.test(host);
  const hasJobSegment =
    jobSubdomain ||
    segments.some((segment) => JOB_SEGMENTS.has(segment.toLowerCase()));
  // A segment naming one posting rather than the hiring area it sits in.
  const discriminator = segments.some(
    (segment) =>
      !JOB_SEGMENTS.has(segment.toLowerCase()) && hasDiscriminator(segment)
  );

  if (!discriminator) return hasJobSegment ? "landing-page" : "not-a-posting";
  // Without a job board host or a job-ish segment, a slug is just a page.
  if (!hasJobSegment) return "not-a-posting";
  // A company domain announces the hiring area in the path, so a lone slug
  // there ("example.com/strategic-finance") is a marketing page.
  if (!jobSubdomain && segments.length < 2) return "not-a-posting";
  return "posting";
}

export function scoreRoleCandidate({
  title,
  url,
  text,
  wanted,
}: {
  title: string;
  url: string;
  text: string;
  wanted: readonly string[];
}): RoleRelevance {
  const shape = postingShape(url);
  if (shape !== "posting")
    return { verdict: "reject", reason: shape, matched: [] };

  const trimmedTitle = title.trim();
  if (!trimmedTitle || GENERIC_TITLE_RE.test(trimmedTitle)) {
    return { verdict: "reject", reason: "generic-title", matched: [] };
  }

  // With nothing asked for there is nothing to mismatch; the posting shape and
  // title checks above have already done the work.
  if (wanted.length === 0) {
    return { verdict: "accept", reason: "ok", matched: [] };
  }

  const inTitle = matchedIn(trimmedTitle, wanted);
  if (inTitle.length)
    return { verdict: "accept", reason: "ok", matched: inTitle };

  // Some ATS pages title themselves with just the company, so fall back to the
  // opening of the page body — but only for a title too short to judge.
  if (trimmedTitle.length <= 32) {
    const inText = matchedIn(text.slice(0, 400), wanted);
    if (inText.length)
      return { verdict: "accept", reason: "ok", matched: inText };
  }

  return { verdict: "reject", reason: "title-mismatch", matched: [] };
}

const US_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
]);

const COUNTRIES = [
  "Australia",
  "Brazil",
  "Canada",
  "France",
  "Germany",
  "India",
  "Ireland",
  "Israel",
  "Japan",
  "Mexico",
  "Netherlands",
  "Poland",
  "Portugal",
  "Singapore",
  "Spain",
  "Sweden",
  "Switzerland",
  "United Kingdom",
  "United States",
] as const;

const WORK_MODE_RE = /\b(remote|hybrid|on-?site)\b/iu;
const CITY_STATE_RE =
  /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}), ([A-Z]{2})\b/u;

/**
 * The posting's own location. This used to be the *requested* location echoed
 * back, so a Berlin role read "Remote" because that was the search input, and
 * the card rendered the search term as fact.
 *
 * Returns "" when unknown: `jobCardView` drops an empty location, so the card
 * shows no location line rather than a wrong one.
 */
export function locationFromResult(title: string, text: string) {
  const haystacks = [title, text.slice(0, 600)];

  for (const haystack of haystacks) {
    const cityState = CITY_STATE_RE.exec(haystack);
    if (cityState?.[1] && US_STATES.has(cityState[2] ?? "")) {
      const mode = WORK_MODE_RE.exec(haystack)?.[1];
      const place = `${cityState[1]}, ${cityState[2] ?? ""}`;
      return mode ? `${place} (${titleCaseMode(mode)})` : place;
    }
  }

  for (const haystack of haystacks) {
    for (const country of COUNTRIES) {
      const match = new RegExp(
        `\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}), ${country}\\b`,
        "u"
      ).exec(haystack);
      if (match?.[1]) return `${match[1]}, ${country}`;
    }
  }

  for (const haystack of haystacks) {
    const mode = WORK_MODE_RE.exec(haystack)?.[1];
    if (mode) return titleCaseMode(mode);
  }
  return "";
}

function titleCaseMode(value: string) {
  const key = value.toLowerCase().replace("onsite", "on-site");
  return key === "remote" ? "Remote" : key === "hybrid" ? "Hybrid" : "On-site";
}

const BOILERPLATE_RE =
  /cookie|sign in|log in|all rights reserved|privacy policy|©|subscribe|newsletter/iu;
const ROLE_SENTENCE_RE =
  /responsibilities|you will|you'll|about the role|we are looking|we're looking|reporting to|this role/iu;

/**
 * Why this role fits, rather than the first 280 characters of the page. The old
 * slice was clipped to 62 characters downstream, so a candidate read the start
 * of a nav bar as the reason a role suited them.
 */
export function reasonsForCandidate({
  matched,
  text,
  wanted,
}: {
  matched: readonly string[];
  text: string;
  wanted: readonly string[];
}) {
  const reasons: string[] = [];
  const best = matched[0];
  if (best) reasons.push(`matches ${best}`);

  const sentence = roleSentence(text, wanted);
  if (sentence) reasons.push(sentence);
  return reasons;
}

function roleSentence(text: string, wanted: readonly string[]) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  for (const raw of normalized.split(/(?<=[.!?])\s+/u)) {
    const sentence = raw.trim();
    if (sentence.length < 30 || sentence.length > 140) continue;
    if (BOILERPLATE_RE.test(sentence)) continue;
    // A run of pipes is a navigation bar, not prose.
    if ((sentence.match(/\|/gu) ?? []).length > 3) continue;
    const relevant =
      ROLE_SENTENCE_RE.test(sentence) || matchedIn(sentence, wanted).length > 0;
    if (relevant) return sentence;
  }
  return undefined;
}
