import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
// @boundaries-ignore shared wire contract lives in the app package (lib/browser/contract.ts)
import {
  actionsRequestSchema,
  cdpRequestSchema,
  createSessionRequestSchema,
  playwrightRequestSchema,
  screenshotRequestSchema,
  stageFileRequestSchema,
} from "../../../lib/browser/contract.ts";
import { GatewayHttpError, gatewayError } from "./errors.ts";
import { errorStack, errorSummary, log, logError } from "./log.ts";
import {
  peekEventLoopDelay,
  readEventLoopDelay,
  readMemory,
} from "./metrics.ts";
import type { GatewaySessions } from "./registry.ts";

export interface AppDeps {
  authSecret: string;
  sessions: GatewaySessions;
}

/** Structural parser type so app.ts never touches zod instances directly. */
interface Parser<T> {
  safeParse(
    input: unknown
  ):
    | { data: T; success: true }
    | { error: { message: string }; success: false };
}

async function parseBody<T>(c: Context, schema: Parser<T>): Promise<T> {
  const json = await c.req.json<unknown>().catch(() => {
    throw gatewayError(400, "invalid_request", "Request body must be JSON.");
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw gatewayError(400, "invalid_request", parsed.error.message);
  }
  return parsed.data;
}

/** Constant-time bearer comparison; hashing first equalizes lengths. */
function bearerMatches(header: string | undefined, secret: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(prefix.length)), digest(secret));
}

/** Session ids are random and per-run; the route shape is what the log needs. */
function redactPath(path: string): string {
  return path.replace(/^\/sessions\/[^/]+/u, "/sessions/:id");
}

export function createApp({ authSecret, sessions }: AppDeps): Hono {
  const state = { draining: false };
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof GatewayHttpError) {
      logError("request.error", {
        code: error.body.error.code,
        method: c.req.method,
        path: redactPath(c.req.path),
        reason: errorSummary(error),
        status: error.status,
      });
      return c.json(error.body, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    logError("request.error", {
      code: "gateway_error",
      method: c.req.method,
      path: redactPath(c.req.path),
      reason: errorSummary(error),
      stack: errorStack(error),
      status: 500,
    });
    return c.json({ error: { code: "gateway_error", message } }, 500);
  });

  // One line per request, with the process vitals at the moment it answered.
  // A request that took 40s with loop_max_ms in the tens of thousands is a
  // stalled process; the same request with a flat loop is a slow browser.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const started = Date.now();
    await next();
    const loop = peekEventLoopDelay();
    log("request", {
      heap_used_mb: readMemory().heap_used_mb,
      loop_max_ms: loop.max_ms,
      loop_p99_ms: loop.p99_ms,
      method: c.req.method,
      ms: Date.now() - started,
      path: redactPath(c.req.path),
      sessions: sessions.size,
      status: c.res.status,
    });
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "invalid_request",
          message: `No route ${c.req.method} ${c.req.path}`,
        },
      },
      404
    )
  );

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (!bearerMatches(c.req.header("authorization"), authSecret)) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        },
        401
      );
    }
    return next();
  });

  // Unauthenticated, like the rest of this route: the numbers say how busy
  // this process is, never what it is doing or for whom.
  app.get("/health", (c) =>
    c.json({
      draining: state.draining,
      event_loop: readEventLoopDelay(),
      memory: readMemory(),
      ok: true,
      sessions: sessions.size,
    })
  );

  app.post("/sessions", async (c) => {
    if (state.draining) {
      throw gatewayError(
        503,
        "gateway_error",
        "Gateway is draining ahead of a deploy; new sessions are refused."
      );
    }
    const request = await parseBody(c, createSessionRequestSchema);
    return c.json(await sessions.create(request));
  });

  app.get("/sessions", (c) => c.json({ sessions: sessions.list() }));

  app.get("/sessions/:id", (c) => c.json(sessions.describe(c.req.param("id"))));

  app.delete("/sessions/:id", async (c) =>
    c.json(await sessions.delete(c.req.param("id")))
  );

  app.get("/sessions/:id/storage-state", async (c) =>
    c.json({ storage_state: await sessions.storageState(c.req.param("id")) })
  );

  app.post("/sessions/:id/playwright", async (c) => {
    const request = await parseBody(c, playwrightRequestSchema);
    return c.json(await sessions.runPlaywright(c.req.param("id"), request));
  });

  app.post("/sessions/:id/actions", async (c) => {
    const { actions } = await parseBody(c, actionsRequestSchema);
    return c.json(await sessions.runActions(c.req.param("id"), actions));
  });

  app.post("/sessions/:id/screenshot", async (c) => {
    const request = await parseBody(c, screenshotRequestSchema);
    return c.json({
      images_base64: await sessions.screenshot(c.req.param("id"), request),
    });
  });

  app.post("/sessions/:id/files", async (c) => {
    const { base64, path } = await parseBody(c, stageFileRequestSchema);
    return c.json({
      path: await sessions.stageFile(c.req.param("id"), path, base64),
    });
  });

  app.post("/sessions/:id/cdp-targets", async (c) =>
    c.json(await sessions.cdpTargets(c.req.param("id")))
  );

  app.post("/sessions/:id/cdp", async (c) => {
    const request = await parseBody(c, cdpRequestSchema);
    return c.json({ result: await sessions.cdp(c.req.param("id"), request) });
  });

  /** Deploy discipline: flip to draining, wait for sessions, then deploy. */
  app.post("/admin/drain", (c) => {
    state.draining = true;
    return c.json({ draining: true, ok: true });
  });

  return app;
}
