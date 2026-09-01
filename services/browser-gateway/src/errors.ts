import type { ContentfulStatusCode } from "hono/utils/http-status";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import type {
  GatewayError,
  GatewayErrorCode,
} from "../../../lib/browser/contract.ts";

/** An HTTP failure whose body always parses against `gatewayErrorSchema`. */
export class GatewayHttpError extends Error {
  readonly body: GatewayError;
  readonly status: ContentfulStatusCode;

  constructor(
    status: ContentfulStatusCode,
    code: GatewayErrorCode,
    message: string,
    domains?: string[]
  ) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    this.body = { error: { code, message, ...(domains ? { domains } : {}) } };
  }
}

export function gatewayError(
  status: ContentfulStatusCode,
  code: GatewayErrorCode,
  message: string,
  domains?: string[]
): GatewayHttpError {
  return new GatewayHttpError(status, code, message, domains);
}

export function sessionNotFound(sessionId: string): GatewayHttpError {
  return gatewayError(
    404,
    "session_not_found",
    `No session ${sessionId}. It may have expired and been evicted.`
  );
}

export interface DeadSessionLike {
  deathReason?: "cross_domain_navigation" | "session_gone";
  lastCrossDomain?: { from: string; to: string };
  sessionId: string;
}

/**
 * 410 for a session the registry still remembers but whose browser is gone.
 * When a cross-domain hop was the recorded cause (Brightdata terminates the
 * remote browser on registrable-domain changes), the error says so and names
 * the domains so the app can explain the failure precisely.
 */
export function sessionGone(entry: DeadSessionLike): GatewayHttpError {
  if (
    entry.deathReason === "cross_domain_navigation" &&
    entry.lastCrossDomain
  ) {
    const { from, to } = entry.lastCrossDomain;
    return gatewayError(
      410,
      "cross_domain_navigation",
      `Session ${entry.sessionId} is gone: the browser navigated across registrable domains (from ${from} to ${to}) and the upstream session was terminated.`,
      [from, to]
    );
  }
  return gatewayError(
    410,
    "session_gone",
    `Session ${entry.sessionId} is gone: the upstream browser disconnected.`
  );
}
