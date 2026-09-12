import { z } from "zod";
import {
  actionsResponseSchema,
  cdpResponseSchema,
  cdpTargetsResponseSchema,
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  gatewayErrorSchema,
  playwrightResponseSchema,
  screenshotResponseSchema,
  sessionDescriptorSchema,
  storageStateResponseSchema,
  type GatewayAction,
  type GatewayErrorCode,
} from "@/lib/browser/contract";
import type {
  BrowserScreenshotOptions,
  BrowserSessionDescriptor,
  CreateBrowserSessionOptions,
  GatewayCapableProvider,
} from "@/lib/browser/provider";
import { env } from "@/lib/env";

/**
 * Carries the gateway's HTTP status and error code in the same positions
 * Kernel SDK errors do (`status`, `error.code`), so the worker's
 * `describeBrowserSessionFailure` taxonomy classifies both backends
 * identically.
 */
export class GatewayRequestError extends Error {
  readonly error: { code: GatewayErrorCode | "unknown" };
  readonly status: number;

  constructor(
    status: number,
    code: GatewayErrorCode | "unknown",
    message: string
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.status = status;
    this.error = { code };
  }
}

function gatewayConfig() {
  const url = env.BROWSER_GATEWAY_URL;
  const secret = env.BROWSER_GATEWAY_SECRET;
  if (!url || !secret) {
    throw new Error(
      "BROWSER_GATEWAY_URL and BROWSER_GATEWAY_SECRET must be configured to use the browser gateway."
    );
  }
  return { secret, url: url.replace(/\/+$/u, "") };
}

/**
 * How long the app waits past the gateway's own budget before it stops
 * waiting. `timeout_sec` bounds the script inside the gateway and says
 * nothing about whether the gateway answers: a stalled event loop there used
 * to leave `fetch` waiting with no deadline at all, and an application run
 * would sit on a call that never returned until its lease expired twenty
 * minutes later. The grace covers the network and the gateway's own overhead
 * on top of the budget it was given, so a script that uses all of its time
 * still returns its own structured result rather than being cut off here.
 */
const gatewayGraceMs = 20_000;

/**
 * Assumed budget for routes that carry no script: session create/delete,
 * screenshots, actions, CDP. Generous because connecting a fresh Brightdata
 * browser is the slowest of them, and a ceiling that never fires is still
 * better than the none that was here before.
 */
const gatewayDefaultBudgetSec = 60;

async function gatewayRequest<T>(
  path: string,
  options: {
    body?: unknown;
    /** The server-side budget this call was given, when it carries one. */
    budgetSec?: number;
    method: "DELETE" | "GET" | "POST";
    schema: z.ZodType<T>;
    signal?: AbortSignal;
  }
): Promise<T> {
  const { secret, url } = gatewayConfig();
  const budgetMs =
    (options.budgetSec ?? gatewayDefaultBudgetSec) * 1_000 + gatewayGraceMs;
  const deadline = AbortSignal.timeout(budgetMs);
  const request = {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    method: options.method,
    signal: options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline,
  };
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, request);
  } catch (error) {
    // A caller that cancelled is not a gateway fault, so its own abort
    // reaches it unchanged. Only our deadline becomes a gateway error, and
    // it is given the status a timeout deserves so the existing taxonomy
    // reads it as one rather than as an unknown transport failure.
    if (options.signal?.aborted === true) throw error;
    if (deadline.aborted) {
      throw new GatewayRequestError(
        504,
        "gateway_error",
        `Browser gateway did not answer ${options.method} ${path} within ${String(Math.round(budgetMs / 1_000))}s.`
      );
    }
    throw error;
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = gatewayErrorSchema.safeParse(payload);
    throw new GatewayRequestError(
      response.status,
      parsed.success ? parsed.data.error.code : "unknown",
      parsed.success
        ? parsed.data.error.message
        : `Browser gateway request failed with status ${String(response.status)}.`
    );
  }
  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new GatewayRequestError(
      502,
      "gateway_error",
      `Browser gateway returned an unexpected ${options.method} ${path} response shape.`
    );
  }
  return parsed.data;
}

const gatewayHealthSchema = z.object({
  draining: z.boolean().optional(),
  event_loop: z
    .object({ max_ms: z.number(), mean_ms: z.number(), p99_ms: z.number() })
    .optional(),
  memory: z
    .object({
      heap_total_mb: z.number(),
      heap_used_mb: z.number(),
      rss_mb: z.number(),
    })
    .optional(),
  ok: z.boolean(),
  sessions: z.number(),
});

/**
 * The gateway's own vitals, read the moment a call to it failed, so the
 * failure line in the app's log carries them. Vercel's log is the one that
 * gets read; the gateway's stall or crash used to be visible only from the
 * other side of the socket, as a bare 502 or a request that never returned.
 * Never throws: on a gateway that does not answer, that is the finding.
 */
export async function gatewayHealth(
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  let url: string;
  try {
    url = gatewayConfig().url;
  } catch {
    return { health: "unconfigured" };
  }
  const started = Date.now();
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = gatewayHealthSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!parsed.success) {
      return { health: "unreadable", health_ms: Date.now() - started, health_status: response.status };
    }
    const { event_loop, memory, ok, sessions } = parsed.data;
    return {
      health: ok ? "ok" : "not_ok",
      health_heap_used_mb: memory?.heap_used_mb,
      health_loop_max_ms: event_loop?.max_ms,
      health_loop_p99_ms: event_loop?.p99_ms,
      health_ms: Date.now() - started,
      health_sessions: sessions,
    };
  } catch (error) {
    return {
      health: "unreachable",
      health_error: (error instanceof Error ? error.message : String(error))
        .split("\n")[0]
        ?.slice(0, 120),
      health_ms: Date.now() - started,
    };
  }
}

function descriptor(
  session: z.infer<typeof sessionDescriptorSchema>
): BrowserSessionDescriptor {
  return {
    captcha_detected: session.captcha_detected,
    created_at: session.created_at,
    current_url: session.current_url,
    devtools_url: session.devtools_url,
    session_id: session.session_id,
    status: session.status === "active" ? "active" : "deleted",
    viewport: session.viewport,
  };
}

export const gatewayBrowserProvider: GatewayCapableProvider = {
  name: "gateway",

  async createSession(options: CreateBrowserSessionOptions, signal) {
    const body = createSessionRequestSchema.parse({
      start_url: options.startUrl,
      storage_state: options.storageState,
      // The gateway clamps TTL to its own ceiling; Kernel's multi-day
      // timeout_seconds has no Brightdata equivalent.
      ttl_seconds:
        options.timeoutSeconds === undefined
          ? undefined
          : Math.min(options.timeoutSeconds, 3_600),
      viewport: options.viewport,
    });
    const session = await gatewayRequest("/sessions", {
      body,
      method: "POST",
      schema: sessionDescriptorSchema,
      signal,
    });
    return descriptor(session);
  },

  async getSession(sessionId, _options, signal) {
    const session = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET", schema: sessionDescriptorSchema, signal }
    );
    return descriptor(session);
  },

  async deleteSession(sessionId, signal) {
    const response = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", schema: deleteSessionResponseSchema, signal }
    );
    return { storageState: response.storage_state };
  },

  async executePlaywright(sessionId, request, signal) {
    // The gateway's budget and the app's deadline come from one number, so a
    // script granted more time is waited for longer instead of being cut off
    // by a ceiling that did not move with it.
    const timeoutSec = request.timeoutSec ?? 30;
    return gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/playwright`,
      {
        body: { code: request.code, timeout_sec: timeoutSec },
        budgetSec: timeoutSec,
        method: "POST",
        schema: playwrightResponseSchema,
        signal,
      }
    );
  },

  async stageFile(sessionId, file, signal) {
    await gatewayRequest(`/sessions/${encodeURIComponent(sessionId)}/files`, {
      body: {
        base64: Buffer.from(file.bytes).toString("base64"),
        path: file.path,
      },
      method: "POST",
      schema: z.object({ path: z.string() }),
      signal,
    });
  },

  async exportStorageState(sessionId, signal) {
    const response = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/storage-state`,
      { method: "GET", schema: storageStateResponseSchema, signal }
    );
    return response.storage_state;
  },

  async withCdpPage(sessionId, operation, signal) {
    const targets = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/cdp-targets`,
      { method: "POST", schema: cdpTargetsResponseSchema, signal }
    );
    const send = async (
      method: string,
      params?: object,
      sessionRef?: string
    ) => {
      const response = await gatewayRequest(
        `/sessions/${encodeURIComponent(sessionId)}/cdp`,
        {
          body: { method, params, session_ref: sessionRef },
          method: "POST",
          schema: cdpResponseSchema,
          signal,
        }
      );
      return response.result;
    };
    return operation({
      origin: new URL(targets.page.url).origin,
      send,
      sessionRefs: [targets.page.ref, ...targets.iframes.map(({ ref }) => ref)],
      url: targets.page.url,
    });
  },

  async runAction(sessionId, action: GatewayAction, signal) {
    const response = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/actions`,
      {
        body: { actions: [action] },
        method: "POST",
        schema: actionsResponseSchema,
        signal,
      }
    );
    return { screenshotsBase64: response.screenshots_base64 };
  },

  async captureScreenshots(
    sessionId,
    options: BrowserScreenshotOptions,
    signal
  ) {
    const response = await gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/screenshot`,
      {
        body: {
          mask_css: options.maskCss,
          mask_style_id: options.maskStyleId,
          max_slices: options.maxSlices,
          mode: options.mode,
        },
        method: "POST",
        schema: screenshotResponseSchema,
        signal,
      }
    );
    return response.images_base64.map((image) => Buffer.from(image, "base64"));
  },
};
