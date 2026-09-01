import { nanoid } from "nanoid";
import type { CDPSession } from "playwright-core";
import { gatewayError, type GatewayHttpError } from "./errors.ts";

/** The slice of Playwright's CDPSession the cache needs; fakeable in tests. */
export interface CdpSessionLike {
  detach(): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** A CDP session widened for commands and events outside the standard protocol. */
export interface RawCdpSession extends CdpSessionLike {
  on(event: string, listener: (payload: unknown) => void): void;
}

/**
 * Playwright types `CDPSession.send`/`on` against the standard protocol
 * union, but the gateway's passthrough is deliberately stringly-typed and
 * Brightdata adds custom commands and events (`Page.inspect`,
 * `Captcha.detected`). This is the single widening point; everything else
 * stays typed.
 */
export function asRawCdpSession(session: CDPSession): RawCdpSession {
  // Method bivariance makes CDPSession structurally assignable to the
  // string-typed surface, so no assertion is needed — only this documented
  // funnel function.
  return session;
}

interface CachedRef {
  lastUsed: number;
  session: CdpSessionLike;
}

/** Refs expire after this much inactivity; the app re-attaches when told to. */
export const cdpRefTtlMs = 2 * 60_000;

export function unknownRefError(ref: string): GatewayHttpError {
  return gatewayError(
    400,
    "execution_failed",
    `Unknown or expired CDP session_ref ${ref}; re-attach via POST /sessions/:id/cdp-targets and use the fresh refs.`
  );
}

/**
 * Per-gateway-session cache of attached CDP sessions keyed by opaque refs.
 * A cdp-targets call resets it wholesale (the page may have navigated, so old
 * refs point at stale targets); individual refs also expire after two minutes
 * of inactivity so a forgotten attach cannot pin a detached frame forever.
 */
export class CdpRefCache {
  private pageRef: string | undefined;
  private readonly refs = new Map<string, CachedRef>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = cdpRefTtlMs, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Detaches and forgets every ref. Best effort: targets may be gone. */
  reset(): void {
    for (const { session } of this.refs.values()) {
      void session.detach().catch(() => undefined);
    }
    this.refs.clear();
    this.pageRef = undefined;
  }

  register(session: CdpSessionLike, kind: "iframe" | "page"): string {
    const ref = nanoid();
    this.refs.set(ref, { lastUsed: this.now(), session });
    if (kind === "page") this.pageRef = ref;
    return ref;
  }

  /**
   * Session for an explicit ref (throws 400 when unknown or expired), or the
   * current page ref when omitted (undefined when nothing is attached yet —
   * the registry then auto-attaches).
   */
  resolve(ref: string | undefined): CdpSessionLike | undefined {
    this.sweep();
    if (ref === undefined) {
      if (this.pageRef === undefined) return undefined;
      const cached = this.refs.get(this.pageRef);
      if (!cached) {
        this.pageRef = undefined;
        return undefined;
      }
      cached.lastUsed = this.now();
      return cached.session;
    }
    const cached = this.refs.get(ref);
    if (!cached) throw unknownRefError(ref);
    cached.lastUsed = this.now();
    return cached.session;
  }

  /** Detaches refs idle past the TTL. Called on access and by the keepalive. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [ref, cached] of this.refs) {
      if (cached.lastUsed >= cutoff) continue;
      void cached.session.detach().catch(() => undefined);
      this.refs.delete(ref);
      if (this.pageRef === ref) this.pageRef = undefined;
    }
  }
}
