import { createHash } from "node:crypto";

export const APPLICATION_WORKER_ACTIVE_MS = 20 * 60_000;
export const APPLICATION_WATCHDOG_LEAD_MS = 60_000;
/**
 * How long an unfinished execution for the same posting blocks a second
 * worker. Long enough to cover a run and a candidate's approval pause, short
 * enough that a parked worker whose session died silently does not lock the
 * posting for good: nothing else reaps a `waiting` row.
 */
export const APPLICATION_DUPLICATE_WORKER_WINDOW_MS = 2 * 60 * 60_000;
/**
 * How long a `queued` row with no worker session still counts as a worker on
 * its way. eve records the dispatch before the child starts, and a dispatch
 * eve then refuses (for example `AGENT_BUSY`) leaves a row nothing ever
 * attaches to; past this grace such a row is a dead dispatch, not a worker.
 */
export const APPLICATION_DISPATCH_GRACE_MS = 60_000;

export interface ApplicationIdentity {
  applyUrl: string;
  company: string;
  role: string;
}

/**
 * The header is deliberately the only assignment text tracing ever reads.
 * Worker assignments include profile data, so parsing arbitrary prose here
 * would turn observability into a privacy leak.
 */
const identityHeader =
  /^Application trace identity:\s*role=(?<role>[^;\n]{1,160});\s*company=(?<company>[^;\n]{0,160});\s*apply_url=(?<url>\S+)\s*$/imu;

export function executionId(rootSessionId: string, parentCallId: string) {
  return createHash("sha256")
    .update(`${rootSessionId}:${parentCallId}`)
    .digest("hex");
}

export function parseApplicationIdentity(value: unknown): ApplicationIdentity {
  if (typeof value !== "string") return emptyIdentity();
  const match = identityHeader.exec(value);
  if (!match?.groups) return emptyIdentity();
  return {
    applyUrl: safeApplyUrl(match.groups.url ?? ""),
    company: safeLabel(match.groups.company ?? ""),
    role: safeLabel(match.groups.role ?? ""),
  };
}

export function safeApplyUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.origin}${url.pathname}`.slice(0, 1_000);
  } catch {
    return "";
  }
}

function safeLabel(value: string) {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

export function safeErrorCode(value: unknown) {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "unknown";
  return (
    message
      .replace(/https?:\/\/\S+/gu, "url")
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/[^a-zA-Z0-9:_\- ]/gu, "")
      .trim()
      .slice(0, 120) || "unknown"
  );
}

export function applicationExecutionLog(event: Record<string, unknown>) {
  // Do not pass arbitrary error objects or action inputs into this log.
  console.info("[application-execution]", event);
}

export function isApplicationWorkerDeadlineReached(
  startedAt: string,
  now = Date.now()
) {
  return Date.parse(startedAt) + APPLICATION_WORKER_ACTIVE_MS <= now;
}

export function applicationLeaseExpiresAt(
  claimedAt = new Date(),
  activeMs = APPLICATION_WORKER_ACTIVE_MS
) {
  return new Date(claimedAt.getTime() + activeMs).toISOString();
}

export function isApplicationLeaseExpired(expiresAt: string, now = Date.now()) {
  return Date.parse(expiresAt) <= now;
}

function emptyIdentity(): ApplicationIdentity {
  return { applyUrl: "", company: "", role: "" };
}
