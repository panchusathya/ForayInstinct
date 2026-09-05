import { z } from "zod";

/**
 * Wire contract between the app and the browser gateway service
 * (`services/browser-gateway`). The gateway imports these schemas relatively,
 * so both sides always validate against the same shapes. Error codes mirror
 * Kernel's session-death vocabulary (`session_gone`, `session_not_found`) so
 * the worker's failure taxonomy ports across providers unchanged.
 */

export const gatewayErrorCodeSchema = z.enum([
  "session_gone",
  "session_not_found",
  "cross_domain_navigation",
  "execution_failed",
  "invalid_request",
  "unauthorized",
  "gateway_error",
]);
export type GatewayErrorCode = z.infer<typeof gatewayErrorCodeSchema>;

export const gatewayErrorSchema = z.object({
  error: z.object({
    code: gatewayErrorCodeSchema,
    message: z.string(),
    /** Set on cross_domain_navigation: the domains involved. */
    domains: z.array(z.string()).optional(),
  }),
});
export type GatewayError = z.infer<typeof gatewayErrorSchema>;

export const viewportSchema = z.object({
  height: z.number().int().min(1),
  width: z.number().int().min(1),
});

/**
 * Playwright's `context.storageState()` JSON. Kept opaque: the app persists
 * and returns it verbatim, only the gateway interprets it.
 */
export const storageStateSchema = z.object({
  cookies: z.array(z.record(z.string(), z.unknown())),
  origins: z.array(z.record(z.string(), z.unknown())),
});
export type GatewayStorageState = z.infer<typeof storageStateSchema>;

export const createSessionRequestSchema = z.object({
  start_url: z.url().optional(),
  storage_state: storageStateSchema.optional(),
  /** Seconds the gateway keeps the session alive without app activity. */
  ttl_seconds: z.number().int().min(60).max(3_600).optional(),
  viewport: viewportSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionDescriptorSchema = z.object({
  captcha_detected: z.boolean(),
  created_at: z.string(),
  current_url: z.string().optional(),
  devtools_url: z.string().optional(),
  initial_domain: z.string().optional(),
  session_id: z.string(),
  status: z.enum(["active", "dead"]),
  viewport: viewportSchema,
});
export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionDescriptorSchema),
});

export const deleteSessionResponseSchema = z.object({
  storage_state: storageStateSchema.optional(),
});

export const storageStateResponseSchema = z.object({
  storage_state: storageStateSchema,
});

/** Kernel's `browsers.playwright.execute` envelope, preserved byte-for-byte. */
export const playwrightRequestSchema = z.object({
  code: z.string().min(1),
  timeout_sec: z.number().int().min(1).max(120).optional(),
});
export type PlaywrightRequest = z.infer<typeof playwrightRequestSchema>;

export const playwrightResponseSchema = z.object({
  error: z.string().optional(),
  result: z.unknown().optional(),
  success: z.boolean(),
});
export type PlaywrightResponse = z.infer<typeof playwrightResponseSchema>;

const holdKeys = z.array(z.string()).optional();

export const gatewayActionSchema = z.object({
  type: z.enum([
    "click_mouse",
    "move_mouse",
    "type_text",
    "press_key",
    "scroll",
    "drag_mouse",
    "sleep",
    "screenshot",
  ]),
  click_mouse: z
    .object({
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      hold_keys: holdKeys,
      num_clicks: z.number().int().min(1).optional(),
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  move_mouse: z
    .object({ hold_keys: holdKeys, x: z.number(), y: z.number() })
    .optional(),
  type_text: z
    .object({
      delay: z.number().int().min(0).max(250).optional(),
      text: z.string(),
    })
    .optional(),
  press_key: z
    .object({
      duration: z.number().int().min(0).max(2_000).optional(),
      hold_keys: holdKeys,
      keys: z.array(z.string()),
    })
    .optional(),
  scroll: z
    .object({
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      hold_keys: holdKeys,
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  drag_mouse: z
    .object({
      button: z.enum(["left", "middle", "right"]).optional(),
      delay: z.number().int().min(0).max(2_000).optional(),
      hold_keys: holdKeys,
      path: z.array(z.array(z.number()).length(2)).min(2),
      step_delay_ms: z.number().int().min(0).max(250).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
    })
    .optional(),
  sleep: z
    .object({ duration_ms: z.number().int().min(0).max(2_000) })
    .optional(),
  screenshot: z
    .object({
      mask_css: z.string().optional(),
      mask_style_id: z.string().optional(),
      region: z
        .object({
          height: z.number().int().min(1),
          width: z.number().int().min(1),
          x: z.number(),
          y: z.number(),
        })
        .optional(),
    })
    .optional(),
});
export type GatewayAction = z.infer<typeof gatewayActionSchema>;

export const actionsRequestSchema = z.object({
  actions: z.array(gatewayActionSchema).min(1),
});

export const actionsResponseSchema = z.object({
  screenshots_base64: z.array(z.string()).optional(),
});

export const screenshotRequestSchema = z.object({
  /** Vault-mask stylesheet injected into every frame before capture. */
  mask_css: z.string().optional(),
  mask_style_id: z.string().optional(),
  max_slices: z.number().int().min(1).max(10).optional(),
  mode: z.enum(["viewport", "full_page", "review_slices"]),
});
export type ScreenshotRequest = z.infer<typeof screenshotRequestSchema>;

export const screenshotResponseSchema = z.object({
  images_base64: z.array(z.string()),
});

export const stageFileRequestSchema = z.object({
  base64: z.string().min(1),
  /**
   * Caller-chosen gateway-local path. Constrained to the two staging prefixes
   * the worker's stage_* tools promise in their output contracts.
   */
  path: z
    .string()
    .regex(/^\/tmp\/(?:goforay|workspace)-[A-Za-z0-9._-]{1,200}$/u),
});

export const stageFileResponseSchema = z.object({
  /**
   * Gateway-local path. The browser runs at Brightdata, not on the gateway,
   * and over a plain CDP connection Playwright hands `setInputFiles` a path
   * for Chromium to open on *its* machine, so this path attaches nothing
   * there. Attach bytes (`setInputFiles({ name, mimeType, buffer })`) on the
   * gateway; the path is only right where the code runs beside the browser.
   */
  path: z.string(),
});

/**
 * Attaches CDP sessions to the current page target and every out-of-process
 * iframe under it, mirroring Kernel's flat `Target.attachToTarget` transport.
 * Refs are gateway-assigned opaque ids, short-lived (the gateway may expire
 * them after a couple of minutes of inactivity); the page ref comes first.
 */
export const cdpTargetsResponseSchema = z.object({
  iframes: z.array(z.object({ ref: z.string(), url: z.string().optional() })),
  page: z.object({ ref: z.string(), url: z.string() }),
});

export const cdpRequestSchema = z.object({
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  /** A ref from cdp-targets; omitted = the current page target. */
  session_ref: z.string().optional(),
});

export const cdpResponseSchema = z.object({ result: z.unknown() });
