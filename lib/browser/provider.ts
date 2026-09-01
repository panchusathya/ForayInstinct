import type {
  GatewayAction,
  GatewayStorageState,
  PlaywrightResponse,
} from "@/lib/browser/contract";

/**
 * One remote browser session as the worker sees it, whichever backend hosts
 * it. `browser_live_view_url` is Kernel's interactive human viewer;
 * `devtools_url` is the gateway's operator-grade DevTools inspector. A session
 * carries at most one of them.
 */
export interface BrowserSessionDescriptor {
  browser_live_view_url?: string;
  captcha_detected?: boolean;
  created_at?: string;
  current_url?: string;
  devtools_url?: string;
  session_id: string;
  status: "active" | "deleted";
  viewport?: { height: number; width: number };
}

export interface CreateBrowserSessionOptions {
  /** Kernel cookie-persistence profile; ignored by the gateway. */
  kernelProfileId?: string;
  /** Kernel navigates start_url fire-and-forget; the gateway awaits it. */
  startUrl?: string;
  /** Saved storage state to restore; ignored by Kernel (profiles cover it). */
  storageState?: GatewayStorageState;
  timeoutSeconds?: number;
  viewport?: { height: number; width: number };
}

export interface BrowserScreenshotOptions {
  maskCss?: string;
  maskStyleId?: string;
  maxSlices?: number;
  mode: "viewport" | "full_page" | "review_slices";
}

/**
 * A flat CDP transport over the session's current page: the page target plus
 * its out-of-process iframes, addressed by opaque refs. Mirrors the shape of
 * Kernel's raw `Target.attachToTarget` connection so the native-autofill flow
 * runs unchanged on either backend.
 */
export interface CdpPageHandle {
  readonly origin: string;
  /** Arrow-typed so call sites can destructure it without binding `this`. */
  readonly send: (
    method: string,
    params?: object,
    sessionRef?: string
  ) => Promise<unknown>;
  /** Page target first, then out-of-process iframe targets. */
  readonly sessionRefs: readonly string[];
  readonly url: string;
}

export interface BrowserProvider {
  createSession(
    options: CreateBrowserSessionOptions,
    signal?: AbortSignal
  ): Promise<BrowserSessionDescriptor>;
  deleteSession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<{ storageState?: GatewayStorageState }>;
  executePlaywright(
    sessionId: string,
    request: { code: string; timeoutSec?: number },
    signal?: AbortSignal
  ): Promise<PlaywrightResponse>;
  exportStorageState(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<GatewayStorageState | undefined>;
  getSession(
    sessionId: string,
    options?: { includeDeleted?: boolean },
    signal?: AbortSignal
  ): Promise<BrowserSessionDescriptor>;
  readonly name: "gateway" | "kernel";
  stageFile(
    sessionId: string,
    file: { bytes: Uint8Array; path: string },
    signal?: AbortSignal
  ): Promise<void>;
  withCdpPage<T>(
    sessionId: string,
    operation: (page: CdpPageHandle) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>;
}

/**
 * Capabilities only the gateway hosts natively (real Playwright objects in
 * its process). Kernel call sites keep their existing computer.* and
 * screenshot paths and branch via `isGatewayProvider` until cutover retires
 * them.
 */
export interface GatewayCapableProvider extends BrowserProvider {
  captureScreenshots(
    sessionId: string,
    options: BrowserScreenshotOptions,
    signal?: AbortSignal
  ): Promise<Buffer[]>;
  readonly name: "gateway";
  runAction(
    sessionId: string,
    action: GatewayAction,
    signal?: AbortSignal
  ): Promise<{ screenshotsBase64?: string[] }>;
}

export function isGatewayProvider(
  provider: BrowserProvider
): provider is GatewayCapableProvider {
  return provider.name === "gateway";
}
