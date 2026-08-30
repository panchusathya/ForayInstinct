const OTP_SEARCH_TERMS = [
  "otp",
  "passcode",
  "pin",
  "verification",
  '"one-time"',
  '"one time"',
  '"security code"',
  '"verification code"',
] as const;

const LABELED_PATTERNS = [
  /(?:one[-\s]?time|verification|security|login|sign[-\s]?in|authentication)\s+(?:code|pin|passcode)\s*(?:is|:)?\s*([A-Z0-9][A-Z0-9\s-]{2,14}[A-Z0-9])/iu,
  /(?:otp|passcode|pin)\s*(?:is|:)\s*([A-Z0-9][A-Z0-9\s-]{2,14}[A-Z0-9])/iu,
  /(?:your\s+)?(?:code|pin)\s*(?:is|:)\s*([A-Z0-9][A-Z0-9\s-]{2,14}[A-Z0-9])/iu,
  /\b([A-Z0-9]{4,8})\s+is\s+your\s+(?:verification\s+)?(?:code|otp|pin|passcode)/iu,
  /enter\s+(?:the\s+)?(?:code|otp|pin)\s*[:\s]*([A-Z0-9][A-Z0-9\s-]{2,14}[A-Z0-9])/iu,
] as const;

const IGNORE_NEARBY =
  /\b(?:track(?:ing)?|package|shipment|order|invoice|confirmation|reference|ticket|case|reservation)\b/iu;
const AUTH_NEARBY =
  /\b(?:verif(?:y|ication)|otp|passcode|one[-\s]?time|login|sign[-\s]?in|security code|pin)\b/iu;
const YEAR = /^(?:19|20)\d{2}$/u;
const COMPACT_DATE = /^(?:19|20)\d{6}$/u;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/iu;

export function buildEmailOtpSearchQuery(input: {
  fromHint?: string;
  subjectHint?: string;
}) {
  const parts = [`newer_than:15m (${OTP_SEARCH_TERMS.join(" OR ")})`];
  const fromHint = sanitizeGmailQueryToken(input.fromHint);
  if (fromHint) {
    parts.push(
      fromHint.includes("@") || DOMAIN.test(fromHint)
        ? `from:${fromHint}`
        : `"${fromHint}"`
    );
  }
  const subjectHint = sanitizeGmailQueryToken(input.subjectHint);
  if (subjectHint) {
    parts.push(`subject:"${subjectHint}"`);
  }
  return parts.join(" ");
}

export function extractEmailOtp(text: string) {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return null;

  for (const pattern of LABELED_PATTERNS) {
    const match = pattern.exec(normalized);
    const code = match?.[1] ? normalizeOtpCandidate(match[1]) : null;
    if (code && isPlausibleOtp(code)) return code;
  }

  for (const match of normalized.matchAll(/\b(\d{6})\b/gu)) {
    const code = match[1];
    if (!code || !isPlausibleOtp(code)) continue;
    if (isIgnoredNumericContext(normalized, match.index, code.length)) {
      continue;
    }
    return code;
  }
  return null;
}

function sanitizeGmailQueryToken(value: string | undefined) {
  return (
    value?.replaceAll(/["()]/gu, " ").replaceAll(/\s+/gu, " ").trim() ?? ""
  );
}

function normalizeOtpCandidate(raw: string) {
  return raw.replaceAll(/[\s-]/gu, "").toUpperCase();
}

function isPlausibleOtp(code: string) {
  if (code.length < 4 || code.length > 8) return false;
  if (!/^[A-Z0-9]+$/u.test(code)) return false;
  if (!/\d/u.test(code)) return false;
  if (YEAR.test(code) || COMPACT_DATE.test(code)) return false;
  return true;
}

function isIgnoredNumericContext(text: string, index: number, length: number) {
  const window = text.slice(Math.max(0, index - 40), index + length + 40);
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/u.test(window)) return true;
  if (IGNORE_NEARBY.test(window) && !AUTH_NEARBY.test(window)) return true;
  return false;
}
