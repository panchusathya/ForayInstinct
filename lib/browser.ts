import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, isNull, like, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { Browserbase } from "@browserbasehq/sdk";
import {
  chromium,
  type Browser,
  type BrowserContext,
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
const playwrightTimeoutMs = 60_000;
const browserStateTtlMs = 30 * 24 * 60 * 60 * 1000;
const browserFileKeyPrefix = "browser-file:";
const browserMetaKeyPrefix = "browser-meta:";
const browserStorageKeyPrefix = "browser-storage:";

export const browserTimeoutFloorSeconds = 15 * 60;
export const browserbaseMaxSessionSeconds = 6 * 60 * 60;

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

export async function browserCdpUrl(sessionId: string) {
  const session = await ensureBrowserbaseSession(sessionId);
  if (!session.connectUrl) {
    throw new Error("Browserbase did not return a CDP connection URL.");
  }
  return session.connectUrl;
}

export function clampBrowserTimeoutSeconds(timeoutSeconds?: number) {
  const requested = timeoutSeconds ?? browserTimeoutFloorSeconds;
  return Math.min(
    Math.max(requested, browserTimeoutFloorSeconds),
    browserbaseMaxSessionSeconds
  );
}

export function browserKeepAliveUntil(
  createdAt: string,
  timeoutSeconds: number,
  nowMs = Date.now()
) {
  const createdMs = Date.parse(createdAt);
  const sessionEnd = Number.isNaN(createdMs)
    ? nowMs + browserbaseMaxSessionSeconds * 1000
    : createdMs + browserbaseMaxSessionSeconds * 1000;
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
  const browserbaseContext = await browserbase().contexts.create({
    name: `foray-${sessionId}`,
  });
  const browserbaseSession = await createBrowserbaseSession({
    contextId: browserbaseContext.id,
    timeoutSeconds,
    viewport: input.viewport,
  }).catch(async (error: unknown) => {
    await browserbase()
      .contexts.delete(browserbaseContext.id)
      .catch(() => undefined);
    throw error;
  });
  const createdAt = new Date().toISOString();
  await saveBrowserMeta(sessionId, {
    browserbaseContextId: browserbaseContext.id,
    browserbaseSessionId: browserbaseSession.id,
    createdAt,
    keepAliveUntil: browserKeepAliveUntil(createdAt, timeoutSeconds),
    liveView: "",
    timeoutSeconds,
    viewport: input.viewport,
  });
  const handle = await connectRemoteBrowser(
    sessionId,
    browserbaseSession.connectUrl
  );
  try {
    if (input.viewport) await handle.page.setViewportSize(input.viewport);
    if (input.startUrl) {
      await handle.page.goto(input.startUrl, {
        timeout: 120_000,
        waitUntil: "domcontentloaded",
      });
    }
    const liveView = await inspectLiveView(sessionId);
    await saveBrowserMeta(sessionId, {
      liveView,
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
    await restoreSessionIfNeeded(handle.page, sessionId);
    await handle.page.setViewportSize(viewport);
    const liveView = await inspectLiveView(sessionId);
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
    if (!parsed.success) continue;
    if (!shouldKeepAliveBrowser(parsed.data)) {
      await releaseBrowserbaseSession(parsed.data);
      await saveBrowserMeta(sessionId, { browserbaseSessionId: null });
      continue;
    }
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
  const existing = await readBrowserMeta(sessionId);
  if (existing) {
    await releaseBrowserbaseSession(existing);
    if (existing.browserbaseContextId) {
      await browserbase()
        .contexts.delete(existing.browserbaseContextId)
        .catch(() => undefined);
    }
  }
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

async function connectRemoteBrowser(sessionId: string, connectUrl?: string) {
  const browser = await chromium.connectOverCDP(
    connectUrl ?? (await browserCdpUrl(sessionId)),
    {
      timeout: 60_000,
    }
  );
  const existing = pickExistingPage(
    browser.contexts().flatMap((context) => context.pages())
  );
  const page =
    existing ?? (await browser.contexts().at(0)?.newPage()) ?? undefined;
  if (!page) {
    await releaseRemoteBrowser(browser);
    throw new Error("Browserbase did not expose a browser page.");
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
    await restoreSessionIfNeeded(handle.page, sessionId);
    const liveView = await inspectLiveView(sessionId);
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

async function inspectLiveView(sessionId: string) {
  const meta = await readBrowserMeta(sessionId);
  if (!meta?.browserbaseSessionId) {
    throw new Error("The Browserbase session is no longer available.");
  }
  const liveView = await browserbase().sessions.debug(
    meta.browserbaseSessionId
  );
  return liveView.debuggerFullscreenUrl;
}

async function saveBrowserMeta(
  sessionId: string,
  patch: {
    createdAt?: string;
    browserbaseContextId?: string;
    browserbaseSessionId?: string | null;
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
      browserbaseContextId:
        patch.browserbaseContextId ?? existing?.browserbaseContextId,
      browserbaseSessionId:
        patch.browserbaseSessionId === undefined
          ? (existing?.browserbaseSessionId ?? null)
          : patch.browserbaseSessionId,
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
  // those contexts, so close() only drops the CDP websocket. The Browserbase
  // Context retains profile state after this connection closes.
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

function browserbase() {
  return new Browserbase({ apiKey: env.BROWSERBASE_API_KEY });
}

async function createBrowserbaseSession({
  contextId,
  timeoutSeconds,
  viewport,
}: {
  contextId: string;
  timeoutSeconds: number;
  viewport?: { height: number; width: number };
}) {
  return browserbase().sessions.create({
    api_timeout: browserbaseMaxSessionSeconds,
    browserSettings: {
      context: { id: contextId, persist: true },
      ...(viewport ? { viewport } : {}),
    },
    keepAlive: true,
    userMetadata: { timeoutSeconds },
  });
}

async function ensureBrowserbaseSession(sessionId: string) {
  const meta = await readBrowserMeta(sessionId);
  if (!meta?.browserbaseContextId) {
    throw new Error(
      "Browser session not found or its persistent Context expired."
    );
  }

  if (meta.browserbaseSessionId) {
    const existing = await browserbase()
      .sessions.retrieve(meta.browserbaseSessionId)
      .catch(() => undefined);
    if (existing?.connectUrl) return existing;
  }

  const replacement = await createBrowserbaseSession({
    contextId: meta.browserbaseContextId,
    timeoutSeconds: clampBrowserTimeoutSeconds(meta.timeoutSeconds),
    viewport: meta.viewport ?? undefined,
  });
  await saveBrowserMeta(sessionId, {
    browserbaseSessionId: replacement.id,
    liveView: "",
  });
  return replacement;
}

async function releaseBrowserbaseSession(
  meta: z.infer<typeof browserMetaSchema>
) {
  if (!meta.browserbaseSessionId) return;
  await browserbase()
    .sessions.update(meta.browserbaseSessionId, { status: "REQUEST_RELEASE" })
    .catch(() => undefined);
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
  browserbaseContextId: z.string().optional(),
  browserbaseSessionId: z.string().nullable().optional(),
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
