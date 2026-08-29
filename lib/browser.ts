import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, isNull, like, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
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
const brightDataCdpHost = "brd.superproxy.io:9222";
const playwrightTimeoutMs = 30_000;
const browserStateTtlMs = 2 * 60 * 60 * 1000;
const browserFileKeyPrefix = "browser-file:";
const browserMetaKeyPrefix = "browser-meta:";

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

export async function createRemoteBrowser(input: {
  startUrl?: string;
  viewport?: { height: number; width: number };
}) {
  const sessionId = createSessionId();
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
      liveView,
      viewport: input.viewport,
    });
    return {
      browser_live_view_url: liveView,
      created_at: createdAt,
      session_id: sessionId,
      status: "active" as const,
      viewport: input.viewport,
    };
  } finally {
    await handle.browser.close().catch(() => undefined);
  }
}

export async function describeRemoteBrowser(sessionId: string) {
  const handle = await connectRemoteBrowser(sessionId);
  try {
    await prepareSession(handle.page, sessionId);
    const liveView = await inspectLiveView(handle.page);
    const viewport = handle.page.viewportSize() ?? undefined;
    await saveBrowserMeta(sessionId, {
      createdAt: (await readBrowserMeta(sessionId))?.createdAt,
      liveView,
      viewport: viewport ?? undefined,
    });
    return {
      browser_live_view_url: liveView,
      session_id: sessionId,
      status: "active" as const,
      viewport,
    };
  } finally {
    await handle.browser.close().catch(() => undefined);
  }
}

export async function updateRemoteBrowserViewport(
  sessionId: string,
  viewport: { height: number; width: number }
) {
  const handle = await connectRemoteBrowser(sessionId);
  try {
    await prepareSession(handle.page, sessionId);
    await handle.page.setViewportSize(viewport);
    const liveView = await inspectLiveView(handle.page);
    await saveBrowserMeta(sessionId, {
      createdAt: (await readBrowserMeta(sessionId))?.createdAt,
      liveView,
      viewport,
    });
    return {
      browser_live_view_url: liveView,
      session_id: sessionId,
      status: "active" as const,
      viewport,
    };
  } finally {
    await handle.browser.close().catch(() => undefined);
  }
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
  if (!options?.provision && leftoverPages.length > 0) {
    const page = leftoverPages.at(-1);
    if (page) return { browser, page, sessionId };
  }
  try {
    const context = await browser.newContext({
      proxy: decodoProxyForSession(sessionId),
    });
    const page = await context.newPage();
    await Promise.all(
      leftoverPages.map((leftover) => leftover.close().catch(() => undefined))
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
    const fallback = leftoverPages.at(-1);
    if (fallback) return { browser, page: fallback, sessionId };
    const page = await browser.newPage();
    return { browser, page, sessionId };
  }
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
    const javascript = transform(code, {
      disableESTransforms: true,
      transforms: ["typescript"],
    }).code;
    const run = compilePlaywrightScript(javascript);
    return await Promise.race([
      run(handle.browser, handle.page, handle.page.context()),
      abortOrTimeout(signal, playwrightTimeoutMs),
    ]);
  } finally {
    await handle.browser.close().catch(() => undefined);
  }
}

export async function withRemotePage<T>(
  sessionId: string,
  signal: AbortSignal | undefined,
  operate: (handle: BrowserSessionHandle) => Promise<T>
) {
  const handle = await connectRemoteBrowser(sessionId);
  const onAbort = () => {
    void handle.browser.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await prepareSession(handle.page, sessionId);
    return await operate(handle);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await handle.browser.close().catch(() => undefined);
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
  meta: {
    createdAt?: string;
    liveView: string;
    viewport?: { height: number; width: number };
  }
) {
  await upsertStateValue(
    `${browserMetaKeyPrefix}${sessionId}`,
    {
      createdAt: meta.createdAt ?? new Date().toISOString(),
      liveView: meta.liveView,
      viewport: meta.viewport ?? null,
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

function brightDataCredentials(sessionId: string) {
  const separator = env.BRIGHT_DATA_BROWSER_AUTH.indexOf(":");
  const username = env.BRIGHT_DATA_BROWSER_AUTH.slice(0, separator);
  const password = env.BRIGHT_DATA_BROWSER_AUTH.slice(separator + 1);
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
      reject(new Error("Playwright execution exceeded 30 seconds."));
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

async function sendCdp(
  session: Awaited<ReturnType<BrowserContext["newCDPSession"]>>,
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
  liveView: z.string(),
  viewport: z
    .object({
      height: z.number(),
      width: z.number(),
    })
    .nullable()
    .optional(),
});
