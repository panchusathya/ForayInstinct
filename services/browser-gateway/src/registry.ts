import { unlink, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { z } from "zod";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import type {
  CreateSessionRequest,
  GatewayAction,
  GatewayStorageState,
  PlaywrightRequest,
  PlaywrightResponse,
  ScreenshotRequest,
  SessionDescriptor,
  actionsResponseSchema,
  cdpRequestSchema,
  cdpTargetsResponseSchema,
  deleteSessionResponseSchema,
} from "../../../lib/browser/contract.ts";
import { performActions } from "./actions.ts";
import { asRawCdpSession, CdpRefCache } from "./cdp.ts";
import { urlRegistrableDomain } from "./domains.ts";
import { gatewayError, sessionGone, sessionNotFound } from "./errors.ts";
import { runPlaywrightCode } from "./eval.ts";
import { captureScreenshots } from "./screenshot.ts";

const defaultTtlSeconds = 900;
const minTtlSeconds = 60;
const maxTtlSeconds = 3_600;

/**
 * Brightdata drops a CDP session after ~5 minutes of protocol silence; a
 * cheap Runtime.evaluate every minute keeps a session alive between app
 * calls without touching the page.
 */
const keepaliveIntervalMs = 60_000;

/**
 * Dead entries linger so the app observes `session_gone` (410) instead of an
 * ambiguous 404 while it still holds the session id.
 */
const deadEntryRetentionMs = 10 * 60_000;

const defaultViewport = { height: 720, width: 1_280 };

/**
 * The parts of an opaque saved origin the init script can actually replay.
 * Anything that does not parse is skipped rather than rejected: storage state
 * is round-trip data the gateway does not own.
 */
const savedOriginSchema = z.object({
  localStorage: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  origin: z.string(),
});
type SavedOrigin = z.infer<typeof savedOriginSchema>;

/** Brightdata's Page.inspect returns a hosted devtools URL. */
const pageInspectResultSchema = z.object({ url: z.string() });

type DeathReason = "cross_domain_navigation" | "session_gone";
type ActionsResponse = z.infer<typeof actionsResponseSchema>;
type CdpRequest = z.infer<typeof cdpRequestSchema>;
type CdpTargetsResponse = z.infer<typeof cdpTargetsResponseSchema>;
type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

interface SessionEntry {
  browser: Browser;
  captchaDetected: boolean;
  cdpRefs: CdpRefCache;
  context: BrowserContext;
  createdAt: Date;
  currentUrl?: string;
  dead: boolean;
  deathReason?: DeathReason;
  devtoolsUrl?: string;
  evictTimer?: NodeJS.Timeout;
  initialDomain?: string;
  keepaliveCdp?: CDPSession;
  keepaliveTimer?: NodeJS.Timeout;
  lastCrossDomain?: { from: string; to: string };
  sessionId: string;
  stagedFiles: string[];
  ttlDeadline: number;
  ttlMs: number;
  viewport: { height: number; width: number };
}

/** Everything the HTTP layer needs; small enough to fake in tests. */
export interface GatewaySessions {
  readonly size: number;
  cdp(id: string, request: CdpRequest): Promise<unknown>;
  cdpTargets(id: string): Promise<CdpTargetsResponse>;
  closeAll(): Promise<void>;
  create(request: CreateSessionRequest): Promise<SessionDescriptor>;
  delete(id: string): Promise<DeleteSessionResponse>;
  describe(id: string): SessionDescriptor;
  list(): SessionDescriptor[];
  runActions(id: string, actions: GatewayAction[]): Promise<ActionsResponse>;
  runPlaywright(
    id: string,
    request: PlaywrightRequest
  ): Promise<PlaywrightResponse>;
  screenshot(id: string, request: ScreenshotRequest): Promise<string[]>;
  stageFile(id: string, path: string, base64: string): Promise<string>;
  storageState(id: string): Promise<GatewayStorageState>;
}

export class SessionRegistry implements GatewaySessions {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  get size(): number {
    return this.entries.size;
  }

  async create(request: CreateSessionRequest): Promise<SessionDescriptor> {
    const browser = await chromium
      .connectOverCDP(this.endpoint)
      .catch((error: unknown) => {
        throw gatewayError(
          502,
          "gateway_error",
          `Could not connect to the upstream browser: ${describe(error)}`
        );
      });
    try {
      return this.describeEntry(await this.initializeSession(browser, request));
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async initializeSession(
    browser: Browser,
    request: CreateSessionRequest
  ): Promise<SessionEntry> {
    // Brightdata pre-creates a context on connect.
    const context = browser.contexts().at(0) ?? (await browser.newContext());
    if (request.storage_state) {
      const { cookies, origins } = request.storage_state;
      if (cookies.length > 0) {
        // storage_state is opaque round-trip data from a previous
        // context.storageState(); the gateway forwards it uninterpreted.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const cookieParams = cookies as unknown as Parameters<
          BrowserContext["addCookies"]
        >[0];
        await context.addCookies(cookieParams);
      }
      // Playwright cannot inject localStorage into a live context post-hoc,
      // so seed it lazily: every new document whose origin matches gets the
      // saved entries before any page script runs.
      const savedOrigins = origins.flatMap((record) => {
        const parsed = savedOriginSchema.safeParse(record);
        return parsed.success ? [parsed.data] : [];
      });
      if (savedOrigins.length > 0) {
        await context.addInitScript((saved: SavedOrigin[]) => {
          const match = saved.find(
            (candidate) => candidate.origin === location.origin
          );
          if (!match) return;
          for (const item of match.localStorage) {
            try {
              if (localStorage.getItem(item.name) === null) {
                localStorage.setItem(item.name, item.value);
              }
            } catch {
              // Storage can be blocked (sandboxed frame); skip silently.
            }
          }
        }, savedOrigins);
      }
    }
    const page = context.pages().at(0) ?? (await context.newPage());
    if (request.viewport) await page.setViewportSize(request.viewport);
    const ttlSeconds = Math.min(
      Math.max(request.ttl_seconds ?? defaultTtlSeconds, minTtlSeconds),
      maxTtlSeconds
    );
    const entry: SessionEntry = {
      browser,
      captchaDetected: false,
      cdpRefs: new CdpRefCache(),
      context,
      createdAt: new Date(),
      dead: false,
      initialDomain: request.start_url
        ? urlRegistrableDomain(request.start_url)
        : undefined,
      sessionId: nanoid(),
      stagedFiles: [],
      ttlDeadline: Date.now() + ttlSeconds * 1_000,
      ttlMs: ttlSeconds * 1_000,
      viewport: request.viewport ?? page.viewportSize() ?? defaultViewport,
    };
    this.entries.set(entry.sessionId, entry);
    browser.on("disconnected", () => {
      this.markDead(entry);
    });
    context.on("page", (opened) => {
      this.wirePage(entry, opened);
    });
    for (const existing of context.pages()) this.wirePage(entry, existing);
    await this.attachSessionCdp(entry, page);
    if (request.start_url) {
      try {
        await page.goto(request.start_url, {
          timeout: 60_000,
          waitUntil: "domcontentloaded",
        });
      } catch (error) {
        await this.destroy(entry);
        throw gatewayError(
          502,
          "gateway_error",
          `Could not open ${request.start_url}: ${describe(error)}`
        );
      }
    }
    entry.keepaliveTimer = setInterval(() => {
      void this.keepaliveTick(entry);
    }, keepaliveIntervalMs);
    entry.keepaliveTimer.unref();
    return entry;
  }

  /** Holds a CDP session for keepalive, devtools URL, and captcha events. */
  private async attachSessionCdp(
    entry: SessionEntry,
    page: Page
  ): Promise<void> {
    let cdp: CDPSession | undefined;
    try {
      cdp = await entry.context.newCDPSession(page);
    } catch {
      return;
    }
    entry.keepaliveCdp = cdp;
    const raw = asRawCdpSession(cdp);
    try {
      // Page.inspect is a Brightdata custom command (not in the standard
      // protocol); it returns a hosted devtools URL for live debugging. The
      // main frame id comes from the standard Page.getFrameTree.
      const tree = await cdp.send("Page.getFrameTree");
      const inspected = await raw.send("Page.inspect", {
        frameId: tree.frameTree.frame.id,
      });
      const parsed = pageInspectResultSchema.safeParse(inspected);
      if (parsed.success) entry.devtoolsUrl = parsed.data.url;
    } catch {
      // Not fatal: devtools_url simply stays undefined.
    }
    try {
      // Captcha.detected is another Brightdata custom event.
      raw.on("Captcha.detected", () => {
        entry.captchaDetected = true;
      });
    } catch {
      // The event may not exist on this zone; captcha detection stays off.
    }
  }

  private wirePage(entry: SessionEntry, page: Page): void {
    entry.currentUrl = page.url() || entry.currentUrl;
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      entry.currentUrl = url;
      const domain = urlRegistrableDomain(url);
      if (domain && entry.initialDomain && domain !== entry.initialDomain) {
        // Recorded, never blocked: Brightdata itself terminates the session
        // on cross-domain hops, and the recording explains that death.
        entry.lastCrossDomain = { from: entry.initialDomain, to: domain };
      }
    });
  }

  private async keepaliveTick(entry: SessionEntry): Promise<void> {
    if (entry.dead) return;
    if (Date.now() > entry.ttlDeadline) {
      // TTL expiry evicts outright: the app let the session lapse, so a later
      // lookup should see session_not_found rather than session_gone.
      await this.destroy(entry);
      return;
    }
    entry.cdpRefs.sweep();
    try {
      const cdp =
        entry.keepaliveCdp ??
        (entry.keepaliveCdp = await entry.context.newCDPSession(
          this.anyPage(entry)
        ));
      await cdp.send("Runtime.evaluate", { expression: "1" });
    } catch {
      this.markDead(entry);
    }
  }

  private anyPage(entry: SessionEntry): Page {
    const page = entry.context.pages().at(0);
    if (!page) throw new Error("session has no pages");
    return page;
  }

  private markDead(entry: SessionEntry): void {
    if (entry.dead) return;
    entry.dead = true;
    entry.deathReason = entry.lastCrossDomain
      ? "cross_domain_navigation"
      : "session_gone";
    if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
    entry.keepaliveTimer = undefined;
    entry.cdpRefs.reset();
    void this.unlinkStagedFiles(entry);
    void entry.browser.close().catch(() => undefined);
    entry.evictTimer = setTimeout(() => {
      this.entries.delete(entry.sessionId);
    }, deadEntryRetentionMs);
    entry.evictTimer.unref();
  }

  private async destroy(entry: SessionEntry): Promise<void> {
    if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.keepaliveTimer = undefined;
    entry.evictTimer = undefined;
    entry.dead = true;
    entry.cdpRefs.reset();
    this.entries.delete(entry.sessionId);
    await this.unlinkStagedFiles(entry);
    await entry.browser.close().catch(() => undefined);
  }

  private async unlinkStagedFiles(entry: SessionEntry): Promise<void> {
    const files = entry.stagedFiles.splice(0);
    await Promise.all(files.map((file) => unlink(file).catch(() => undefined)));
  }

  private requireLive(id: string): SessionEntry {
    const entry = this.entries.get(id);
    if (!entry) throw sessionNotFound(id);
    if (entry.dead || !entry.browser.isConnected()) {
      this.markDead(entry);
      throw sessionGone(entry);
    }
    // Every successful app call extends the deadline by the original TTL.
    entry.ttlDeadline = Date.now() + entry.ttlMs;
    return entry;
  }

  /** The page the user would see: the visible one, else the most recent. */
  private async currentPage(entry: SessionEntry): Promise<Page> {
    const pages = entry.context.pages();
    let visible: Page | undefined;
    for (const candidate of pages) {
      const isVisible = await candidate
        .evaluate(() => document.visibilityState === "visible")
        .catch(() => false);
      if (isVisible) visible = candidate;
    }
    const page = visible ?? pages.at(-1);
    if (page) return page;
    return entry.context.newPage();
  }

  private describeEntry(entry: SessionEntry): SessionDescriptor {
    const active = !entry.dead && entry.browser.isConnected();
    return {
      captcha_detected: entry.captchaDetected,
      created_at: entry.createdAt.toISOString(),
      current_url: entry.currentUrl,
      devtools_url: entry.devtoolsUrl,
      initial_domain: entry.initialDomain,
      session_id: entry.sessionId,
      status: active ? "active" : "dead",
      viewport: entry.viewport,
    };
  }

  describe(id: string): SessionDescriptor {
    return this.describeEntry(this.requireLive(id));
  }

  list(): SessionDescriptor[] {
    return [...this.entries.values()].map((entry) => this.describeEntry(entry));
  }

  /**
   * Idempotent: deleting an unknown or dead session succeeds with an empty
   * body, matching how the app treats Kernel's 404/410-on-delete as success.
   */
  async delete(id: string): Promise<DeleteSessionResponse> {
    const entry = this.entries.get(id);
    if (!entry) return {};
    if (entry.dead || !entry.browser.isConnected()) {
      await this.destroy(entry);
      return {};
    }
    let storageState: GatewayStorageState | undefined;
    try {
      storageState = await entry.context.storageState();
    } catch {
      storageState = undefined;
    }
    await this.destroy(entry);
    return storageState ? { storage_state: storageState } : {};
  }

  async storageState(id: string): Promise<GatewayStorageState> {
    const entry = this.requireLive(id);
    try {
      return await entry.context.storageState();
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `Could not export storage state: ${describe(error)}`
      );
    }
  }

  async runPlaywright(
    id: string,
    request: PlaywrightRequest
  ): Promise<PlaywrightResponse> {
    const entry = this.requireLive(id);
    const page = await this.currentPage(entry);
    return runPlaywrightCode(
      { browser: entry.browser, context: entry.context, page },
      request.code,
      request.timeout_sec ?? 30
    );
  }

  async runActions(
    id: string,
    actions: GatewayAction[]
  ): Promise<ActionsResponse> {
    const entry = this.requireLive(id);
    const page = await this.currentPage(entry);
    try {
      return await performActions(page, actions);
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `Action failed: ${describe(error)}`
      );
    }
  }

  async screenshot(id: string, request: ScreenshotRequest): Promise<string[]> {
    const entry = this.requireLive(id);
    const page = await this.currentPage(entry);
    try {
      return await captureScreenshots(page, request);
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `Screenshot failed: ${describe(error)}`
      );
    }
  }

  /**
   * Writes to the caller-chosen path (the contract restricts it to the
   * /tmp/goforay-* and /tmp/workspace-* staging prefixes the app's stage
   * tools promise). Restaging the same path overwrites. Linux-only paths by
   * design: the gateway must run on Linux for the /tmp contract to hold.
   */
  async stageFile(id: string, path: string, base64: string): Promise<string> {
    const entry = this.requireLive(id);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch (error) {
      throw gatewayError(
        400,
        "invalid_request",
        `Could not decode base64 payload: ${describe(error)}`
      );
    }
    try {
      await writeFile(path, bytes);
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `Could not stage file at ${path}: ${describe(error)}`
      );
    }
    if (!entry.stagedFiles.includes(path)) entry.stagedFiles.push(path);
    return path;
  }

  /**
   * Attaches CDP sessions to the current page and its out-of-process iframes,
   * mirroring Kernel's flat Target.attachToTarget transport. Previous refs
   * are invalidated: the page may have navigated since they were minted.
   */
  async cdpTargets(id: string): Promise<CdpTargetsResponse> {
    const entry = this.requireLive(id);
    const page = await this.currentPage(entry);
    entry.cdpRefs.reset();
    let pageSession: CDPSession;
    try {
      pageSession = await entry.context.newCDPSession(page);
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `Could not attach to the page target: ${describe(error)}`
      );
    }
    const pageRef = entry.cdpRefs.register(
      asRawCdpSession(pageSession),
      "page"
    );
    const iframes: { ref: string; url?: string }[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        // Only out-of-process iframes are separate targets; same-process
        // frames throw here and stay reachable through the page session
        // with frameId params.
        const frameSession = await entry.context.newCDPSession(frame);
        iframes.push({
          ref: entry.cdpRefs.register(asRawCdpSession(frameSession), "iframe"),
          url: frame.url() || undefined,
        });
      } catch {
        continue;
      }
    }
    return { iframes, page: { ref: pageRef, url: page.url() } };
  }

  /** Verbatim passthrough: the gateway interprets nothing. */
  async cdp(id: string, request: CdpRequest): Promise<unknown> {
    const entry = this.requireLive(id);
    let session = entry.cdpRefs.resolve(request.session_ref);
    if (!session) {
      // Nothing attached yet and no explicit ref: attach to the current page.
      await this.cdpTargets(id);
      session = entry.cdpRefs.resolve(undefined);
    }
    if (!session) {
      throw gatewayError(
        400,
        "execution_failed",
        "Could not attach a CDP session to the current page."
      );
    }
    try {
      return await session.send(request.method, request.params);
    } catch (error) {
      throw gatewayError(
        400,
        "execution_failed",
        `CDP ${request.method} failed: ${describe(error)}`
      );
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => this.destroy(entry))
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
