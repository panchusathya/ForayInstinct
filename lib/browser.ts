import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, isNull, like, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { transform } from "sucrase";
import { z } from "zod";
import { chatStateValues, db } from "@/db";
import { env } from "@/lib/env";

const createSessionId = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  21
);
const brightDataCdpHost = "brd.superproxy.io:9222";
const playwrightTimeoutMs = 60_000;
const browserStateTtlMs = 2 * 60 * 60 * 1000;
const browserFileKeyPrefix = "browser-file:";
const browserMetaKeyPrefix = "browser-meta:";
const browserStorageKeyPrefix = "browser-storage:";
const durablePageWaitMs = 8_000;

export const browserTimeoutFloorSeconds = 15 * 60;
export const brightDataMaxSessionSeconds = 60 * 60;

export interface BrowserDescriptor {
  browser_live_view_url: string;
  session_id: string;
  status: "active" | "deleted";
  viewport?: { height: number; width: number };
}

export interface BrowserSessionHandle {
  browser: Browser;
  page: Page;
  sessionId: string;
}

export function browserCdpUrl(sessionId: string) {
  const { password, username } = brightDataCredentials(sessionId);
  return `wss://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${brightDataCdpHost}`;
}

/**
 * Accept the credential pair Bright Data documents as well as a copied CDP
 * endpoint. The latter is easy to paste into an environment variable, but the
 * connection builder owns the endpoint and must not treat it as part of the
 * password.
 */
export function normalizeBrightDataBrowserAuth(value: string) {
  const match =
    /^(?:wss:\/\/)?([^:]+):(.+?)@brd\.superproxy\.io(?::9222)?\/?$/i.exec(
      value.trim()
    );

  if (!match) return value;
  const [, username, password] = match;
  if (typeof username !== "string" || typeof password !== "string")
    return value;
  return `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
}

export function decodoProxyForSession(sessionId: string) {
  const url = new URL(env.DECODO_PROXY_URL);
  const baseUser = decodeURIComponent(url.username);
  const username = stickyDecodoUsername(baseUser, sessionId);
  return {
    password: decodeURIComponent(url.password),
    server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`,
    username,
  };
}

export function clampBrowserTimeoutSeconds(timeoutSeconds?: number) {
  const requested = timeoutSeconds ?? browserTimeoutFloorSeconds;
  return Math.min(
    Math.max(requested, browserTimeoutFloorSeconds),
    brightDataMaxSessionSeconds
  );
}

export function browserKeepAliveUntil(
  createdAt: string,
  timeoutSeconds: number,
  nowMs = Date.now()
) {
  const createdMs = Date.parse(createdAt);
  const sessionEnd = Number.isNaN(createdMs)
    ? nowMs + brightDataMaxSessionSeconds * 1000
    : createdMs + brightDataMaxSessionSeconds * 1000;
  return new Date(
    Math.min(nowMs + timeoutSeconds * 1000, sessionEnd)
  ).toISOString();
}

export function shouldKeepAliveBrowser(
  meta: { keepAliveUntil?: string },
  nowMs = Date.now()
) {
  if (!meta.keepAliveUntil) return false;
  const until = Date.parse(meta.keepAliveUntil);
  return !Number.isNaN(until) && until > nowMs;
}

export async function createRemoteBrowser(input: {
  startUrl?: string;
  timeoutSeconds?: number;
  viewport?: { height: number; width: number };
}) {
  const sessionId = createSessionId();
  const timeoutSeconds = clampBrowserTimeoutSeconds(input.timeoutSeconds);
  const handle = await connectRemoteBrowser(sessionId, { provision: true });
  try {
    await prepareSession(handle.page, sessionId);
    if (input.viewport) await handle.page.setViewportSize(input.viewport);
    if (input.startUrl) {
      await handle.page.goto(input.startUrl, {
        timeout: 120_000,
        waitUntil: "domcontentloaded",
      });
    }
    const liveView = await inspectLiveView(handle.page);
    const createdAt = new Date().toISOString();
    await saveBrowserMeta(sessionId, {
      createdAt,
      keepAliveUntil: browserKeepAliveUntil(createdAt, timeoutSeconds),
      liveView,
      timeoutSeconds,
      viewport: input.viewport,
    });
    await snapshotSession(handle.page, sessionId);
    return {
      browser_live_view_url: liveView,
      created_at: createdAt,
      session_id: sessionId,
      status: "active" as const,
      viewport: input.viewport,
    };
  } finally {
    await releaseRemoteBrowser(handle.browser);
  }
}

export async function describeRemoteBrowser(sessionId: string) {
  return touchRemoteBrowser(sessionId, { extendKeepAlive: true });
}

export async function updateRemoteBrowserViewport(
  sessionId: string,
  viewport: { height: number; width: number }
) {
  const handle = await connectRemoteBrowser(sessionId);
  try {
    await prepareSession(handle.page, sessionId);
    await restoreSessionIfNeeded(handle.page, sessionId);
    await handle.page.setViewportSize(viewport);
    const liveView = await inspectLiveView(handle.page);
    await saveBrowserMeta(sessionId, {
      liveView,
      viewport,
    });
    await persistTouchedSession(handle.page, sessionId, {
      extendKeepAlive: true,
    });
    return {
      browser_live_view_url: liveView,
      session_id: sessionId,
      status: "active" as const,
      viewport,
    };
  } finally {
    await releaseRemoteBrowser(handle.browser);
  }
}

export async function extendRemoteBrowserKeepAlive(
  sessionId: string,
  timeoutSeconds?: number
) {
  const existing = await readBrowserMeta(sessionId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const clamped = clampBrowserTimeoutSeconds(
    timeoutSeconds ?? existing?.timeoutSeconds
  );
  await saveBrowserMeta(sessionId, {
    createdAt,
    keepAliveUntil: browserKeepAliveUntil(createdAt, clamped),
    liveView: existing?.liveView ?? "",
    timeoutSeconds: clamped,
    viewport: existing?.viewport ?? undefined,
  });
}

export async function keepAliveActiveBrowsers() {
  const rows = await db
    .select({ key: chatStateValues.key, value: chatStateValues.value })
    .from(chatStateValues)
    .where(
      and(like(chatStateValues.key, `${browserMetaKeyPrefix}%`), unexpired())
    );
  for (const row of rows) {
    const sessionId = row.key.slice(browserMetaKeyPrefix.length);
    if (sessionId.length === 0) continue;
    const parsed = browserMetaSchema.safeParse(row.value);
    if (!parsed.success || !shouldKeepAliveBrowser(parsed.data)) continue;
    try {
      await touchRemoteBrowser(sessionId, { extendKeepAlive: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          error: message,
          kind: "browser.keepalive_failed",
          sessionId,
        })
      );
    }
  }
}

export async function forgetRemoteBrowser(sessionId: string) {
  await db
    .delete(chatStateValues)
    .where(
      or(
        eq(chatStateValues.key, `${browserMetaKeyPrefix}${sessionId}`),
        eq(chatStateValues.key, `${browserStorageKeyPrefix}${sessionId}`),
        like(chatStateValues.key, `${browserFileKeyPrefix}${sessionId}:%`)
      )
    );
}

async function connectRemoteBrowser(
  sessionId: string,
  options?: { provision?: boolean }
) {
  const browser = await chromium.connectOverCDP(browserCdpUrl(sessionId), {
    timeout: 60_000,
  });
  const leftoverPages = browser
    .contexts()
    .flatMap((context) => context.pages());
  const existing = pickExistingPage(leftoverPages);
  if (!options?.provision && existing) {
    return { browser, page: existing, sessionId };
  }
  if (options?.provision) {
    try {
      const page = await attachDurableDecodoPage(
        browser,
        sessionId,
        leftoverPages
      );
      return { browser, page, sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          error: message,
          kind: "browser.decodo_attach_failed",
          sessionId,
        })
      );
      if (existing) return { browser, page: existing, sessionId };
    }
  }
  const page =
    existing ?? (await browser.contexts().at(0)?.newPage()) ?? undefined;
  if (!page) {
    await releaseRemoteBrowser(browser);
    throw new Error("Bright Data did not expose a browser page.");
  }
  return { browser, page, sessionId };
}

export async function executePlaywrightCode(
  sessionId: string,
  code: string,
  signal?: AbortSignal
) {
  await materializeStagedFiles(sessionId);
  const handle = await connectRemoteBrowser(sessionId);
  try {
    await prepareSession(handle.page, sessionId);
    await restoreSessionIfNeeded(handle.page, sessionId);
    const javascript = transform(code, {
      disableESTransforms: true,
      transforms: ["typescript"],
    }).code;
    const run = compilePlaywrightScript(javascript);
    const result = await Promise.race([
      run(handle.browser, handle.page, handle.page.context()),
      abortOrTimeout(signal, playwrightTimeoutMs),
    ]);
    await persistTouchedSession(handle.page, sessionId, {
      extendKeepAlive: true,
    });
    return result;
  } finally {
    await releaseRemoteBrowser(handle.browser);
  }
}

export async function withRemotePage<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  operate: (handle: BrowserSessionHandle) => Promise<T>
) {
  const handle = await connectRemoteBrowser(sessionId);
  const onAbort = () => {
    void releaseRemoteBrowser(handle.browser);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await prepareSession(handle.page, sessionId);
    await restoreSessionIfNeeded(handle.page, sessionId);
    const result = await operate(handle);
    await persistTouchedSession(handle.page, sessionId, {
      extendKeepAlive: true,
    });
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await releaseRemoteBrowser(handle.browser);
  }
}

export async function writeBrowserFile(
  sessionId: string,
  filePath: string,
  bytes: Uint8Array
) {
  await upsertStateValue(
    `${browserFileKeyPrefix}${sessionId}:${filePath}`,
    {
      base64: Buffer.from(bytes).toString("base64"),
      path: filePath,
    },
    browserStateTtlMs
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

async function touchRemoteBrowser(
  sessionId: string,
  options: { extendKeepAlive: boolean }
) {
  const handle = await connectRemoteBrowser(sessionId);
  try {
    await prepareSession(handle.page, sessionId);
    await restoreSessionIfNeeded(handle.page, sessionId);
    const liveView = await inspectLiveView(handle.page);
    const viewport = handle.page.viewportSize() ?? undefined;
    await saveBrowserMeta(sessionId, {
      liveView,
      viewport,
    });
    await persistTouchedSession(handle.page, sessionId, options);
    return {
      browser_live_view_url: liveView,
      session_id: sessionId,
      status: "active" as const,
      viewport,
    };
  } finally {
    await releaseRemoteBrowser(handle.browser);
  }
}

async function attachDurableDecodoPage(
  browser: Browser,
  sessionId: string,
  leftoverPages: Page[]
) {
  const proxy = decodoProxyForSession(sessionId);
  const session = await browser.newBrowserCDPSession();
  const created = asRecord(
    await sendCdp(session, "Target.createBrowserContext", {
      disposeOnDetach: false,
      proxyServer: authenticatedProxyServer(proxy),
    })
  );
  const browserContextId =
    typeof created.browserContextId === "string"
      ? created.browserContextId
      : undefined;
  if (typeof browserContextId !== "string") {
    throw new Error("Bright Data did not create a durable proxy context.");
  }
  await sendCdp(session, "Target.createTarget", {
    browserContextId,
    url: "about:blank",
  });
  const page = await waitForNewPage(browser, leftoverPages);
  await Promise.all(
    leftoverPages.map((leftover) => leftover.close().catch(() => undefined))
  );
  return page;
}

async function waitForNewPage(browser: Browser, leftoverPages: Page[]) {
  const previous = new Set(leftoverPages);
  const deadline = Date.now() + durablePageWaitMs;
  while (Date.now() < deadline) {
    const found = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => !previous.has(page));
    if (found) return found;
    await sleep(100);
  }
  throw new Error("Durable proxy context did not open a page.");
}

async function materializeStagedFiles(sessionId: string) {
  const rows = await db
    .select({ value: chatStateValues.value })
    .from(chatStateValues)
    .where(
      and(
        like(chatStateValues.key, `${browserFileKeyPrefix}${sessionId}:%`),
        unexpired()
      )
    );
  for (const row of rows) {
    const parsed = stagedFileSchema.safeParse(row.value);
    if (!parsed.success) continue;
    await mkdir(path.dirname(parsed.data.path), { recursive: true });
    await writeFile(
      parsed.data.path,
      Buffer.from(parsed.data.base64, "base64")
    );
  }
}

async function prepareSession(page: Page, sessionId: string) {
  const session = await page.context().newCDPSession(page);
  await sendCdp(session, "Proxy.useSession", { sessionId }).catch(
    () => undefined
  );
}

async function restoreSessionIfNeeded(page: Page, sessionId: string) {
  if (!isBlankPage(page)) return;
  const stored = await readBrowserStorage(sessionId);
  if (!stored) return;
  if (stored.cookies.length > 0) {
    await page
      .context()
      .addCookies(stored.cookies)
      .catch(() => undefined);
  }
  if (stored.origins.length > 0 || stored.sessionStorage) {
    await page.context().addInitScript(
      ({ origins, sessionStorage }) => {
        const localStorage = origins.find(
          (origin) => origin.origin === window.location.origin
        )?.localStorage;
        for (const { name, value } of localStorage ?? []) {
          window.localStorage.setItem(name, value);
        }
        if (sessionStorage?.origin !== window.location.origin) return;
        for (const [name, value] of sessionStorage.entries) {
          window.sessionStorage.setItem(name, value);
        }
      },
      {
        origins: stored.origins,
        sessionStorage: stored.sessionStorage,
      }
    );
  }
  if (stored.lastUrl && isHttpUrl(stored.lastUrl)) {
    await page
      .goto(stored.lastUrl, {
        timeout: 120_000,
        waitUntil: "domcontentloaded",
      })
      .catch(() => undefined);
  }
}

async function persistTouchedSession(
  page: Page,
  sessionId: string,
  options: { extendKeepAlive: boolean }
) {
  await snapshotSession(page, sessionId);
  if (!options.extendKeepAlive) return;
  const existing = await readBrowserMeta(sessionId);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  const timeoutSeconds = clampBrowserTimeoutSeconds(existing?.timeoutSeconds);
  await saveBrowserMeta(sessionId, {
    createdAt,
    keepAliveUntil: browserKeepAliveUntil(createdAt, timeoutSeconds),
    lastUrl: page.url(),
    liveView: existing?.liveView ?? "",
    timeoutSeconds,
    viewport: existing?.viewport ?? page.viewportSize() ?? undefined,
  });
}

async function snapshotSession(page: Page, sessionId: string) {
  const state = await page
    .context()
    .storageState()
    .catch(() => undefined);
  const sessionStorage = await page
    .evaluate(() => ({
      entries: Object.entries(window.sessionStorage),
      origin: window.location.origin,
    }))
    .catch(() => undefined);
  await upsertStateValue(
    `${browserStorageKeyPrefix}${sessionId}`,
    {
      cookies: state?.cookies ?? [],
      lastUrl: page.url(),
      origins: state?.origins ?? [],
      sessionStorage,
    },
    browserStateTtlMs
  );
}

async function inspectLiveView(page: Page) {
  const session = await page.context().newCDPSession(page);
  const frames = asRecord(await sendCdp(session, "Page.getFrameTree"));
  const frameTree = asRecord(frames.frameTree);
  const frame = asRecord(frameTree.frame);
  /* oxlint-disable typescript/no-unsafe-assignment -- Bright Data Page.inspect is outside Playwright's CDP typings. */
  const inspect = asRecord(
    await sendCdp(session, "Page.inspect", { frameId: frame.id })
  );
  /* oxlint-enable typescript/no-unsafe-assignment */
  if (typeof inspect.url !== "string" || inspect.url.length === 0) {
    throw new Error("Bright Data did not return a live-view URL.");
  }
  return inspect.url;
}

async function saveBrowserMeta(
  sessionId: string,
  patch: {
    createdAt?: string;
    keepAliveUntil?: string;
    lastUrl?: string | null;
    liveView?: string;
    timeoutSeconds?: number;
    viewport?: { height: number; width: number };
  }
) {
  const existing = await readBrowserMeta(sessionId);
  await upsertStateValue(
    `${browserMetaKeyPrefix}${sessionId}`,
    {
      createdAt:
        patch.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
      keepAliveUntil: patch.keepAliveUntil ?? existing?.keepAliveUntil,
      lastUrl: patch.lastUrl ?? existing?.lastUrl,
      liveView: patch.liveView ?? existing?.liveView ?? "",
      timeoutSeconds: patch.timeoutSeconds ?? existing?.timeoutSeconds,
      viewport: patch.viewport ?? existing?.viewport ?? null,
    },
    browserStateTtlMs
  );
}

async function readBrowserMeta(sessionId: string) {
  const rows = await db
    .select({ value: chatStateValues.value })
    .from(chatStateValues)
    .where(
      and(
        eq(chatStateValues.key, `${browserMetaKeyPrefix}${sessionId}`),
        unexpired()
      )
    );
  const parsed = browserMetaSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : undefined;
}

async function readBrowserStorage(sessionId: string) {
  const rows = await db
    .select({ value: chatStateValues.value })
    .from(chatStateValues)
    .where(
      and(
        eq(chatStateValues.key, `${browserStorageKeyPrefix}${sessionId}`),
        unexpired()
      )
    );
  const parsed = browserStorageSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : undefined;
}

async function upsertStateValue(key: string, value: unknown, ttlMs?: number) {
  const expiresAt = ttlMs === undefined ? null : new Date(Date.now() + ttlMs);
  await db
    .insert(chatStateValues)
    .values({ expiresAt, key, value })
    .onConflictDoUpdate({
      target: chatStateValues.key,
      set: { expiresAt, value },
    });
}

async function releaseRemoteBrowser(browser: Browser) {
  // Playwright's newContext() uses disposeOnDetach. This path never creates
  // those contexts, so close() only drops the CDP websocket. The hosted
  // Chrome, tabs, and cookies stay until Bright Data's idle or max lifetime.
  await browser.close().catch(() => undefined);
}

function pickExistingPage(pages: Page[]) {
  return pages.find((page) => !isBlankPage(page)) ?? pages.at(-1);
}

function isBlankPage(page: Page) {
  const url = page.url();
  return url === "" || url === "about:blank" || url.startsWith("chrome://");
}

function isHttpUrl(value: string) {
  return value.startsWith("https://") || value.startsWith("http://");
}

function authenticatedProxyServer(proxy: {
  password: string;
  server: string;
  username: string;
}) {
  const url = new URL(proxy.server);
  url.username = proxy.username;
  url.password = proxy.password;
  return url.toString();
}

function brightDataCredentials(sessionId: string) {
  const auth = normalizeBrightDataBrowserAuth(env.BRIGHT_DATA_BROWSER_AUTH);
  const separator = auth.indexOf(":");
  const username = auth.slice(0, separator);
  const password = auth.slice(separator + 1);
  const sessionUsername = username.includes("-session-")
    ? username
    : `${username}-session-${sessionId}`;
  return { password, username: sessionUsername };
}

function stickyDecodoUsername(username: string, sessionId: string) {
  if (username.includes("session-")) return username;
  return `${username}-session-${sessionId}-sessionduration-30`;
}

async function abortOrTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
) {
  return new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Playwright execution exceeded 60 seconds."));
    }, timeoutMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Playwright execution was cancelled.")
        );
      },
      { once: true }
    );
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type PlaywrightScript = (
  browser: Browser,
  page: Page,
  context: BrowserContext
) => Promise<unknown>;

function compilePlaywrightScript(javascript: string): PlaywrightScript {
  // Dynamic Playwright scripts are user-authored TypeScript compiled to a
  // function body. AsyncFunction is not in the TypeScript lib typings.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  const AsyncFunction = (async () => undefined).constructor as new (
    ...args: string[]
  ) => PlaywrightScript;
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  return new AsyncFunction("browser", "page", "context", javascript);
}

async function sendCdp(
  session: CDPSession,
  method: string,
  params?: object
): Promise<unknown> {
  // Bright Data custom CDP methods are not in Playwright's protocol types.
  /* oxlint-disable typescript/no-unsafe-type-assertion */
  const result: unknown = await Promise.resolve(
    session.send(method as never, params as never)
  );
  return result;
  /* oxlint-enable typescript/no-unsafe-type-assertion */
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value));
}

function unexpired() {
  return or(
    isNull(chatStateValues.expiresAt),
    gt(chatStateValues.expiresAt, new Date())
  );
}

const stagedFileSchema = z.object({
  base64: z.string(),
  path: z.string(),
});

const browserMetaSchema = z.object({
  createdAt: z.string().optional(),
  keepAliveUntil: z.string().optional(),
  lastUrl: z.string().nullable().optional(),
  liveView: z.string(),
  timeoutSeconds: z.number().optional(),
  viewport: z
    .object({
      height: z.number(),
      width: z.number(),
    })
    .nullable()
    .optional(),
});

const cookieSchema = z.object({
  domain: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  name: z.string(),
  path: z.string().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  secure: z.boolean().optional(),
  url: z.string().optional(),
  value: z.string(),
});

const storageEntrySchema = z.object({
  name: z.string(),
  value: z.string(),
});

const sessionStorageSchema = z.object({
  entries: z.array(z.tuple([z.string(), z.string()])),
  origin: z.string(),
});

const browserStorageSchema = z.object({
  cookies: z.array(cookieSchema),
  lastUrl: z.string().optional(),
  origins: z
    .array(
      z.object({
        localStorage: z.array(storageEntrySchema),
        origin: z.string(),
      })
    )
    .default([]),
  sessionStorage: sessionStorageSchema.optional(),
});
