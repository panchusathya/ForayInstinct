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

async function gatewayRequest<T>(
  path: string,
  options: {
    body?: unknown;
    method: "DELETE" | "GET" | "POST";
    schema: z.ZodType<T>;
    signal?: AbortSignal;
  }
): Promise<T> {
  const { secret, url } = gatewayConfig();
  const response = await fetch(`${url}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    method: options.method,
    signal: options.signal ?? null,
  });
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
    return gatewayRequest(
      `/sessions/${encodeURIComponent(sessionId)}/playwright`,
      {
        body: { code: request.code, timeout_sec: request.timeoutSec ?? 30 },
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
