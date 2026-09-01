import type {
  BrowserCreateResponse,
  BrowserRetrieveResponse,
} from "@onkernel/sdk/resources/browsers";
import { withKernelCdpPage } from "@/lib/browser/kernel-cdp";
import type {
  BrowserProvider,
  BrowserSessionDescriptor,
  CreateBrowserSessionOptions,
} from "@/lib/browser/provider";
import { env } from "@/lib/env";
import { kernel } from "@/lib/kernel";

const browserTimeoutFloorSeconds = 15 * 60;

function descriptor(
  browser: BrowserCreateResponse | BrowserRetrieveResponse
): BrowserSessionDescriptor {
  return {
    browser_live_view_url: browser.browser_live_view_url,
    created_at: browser.created_at,
    session_id: browser.session_id,
    status: browser.deleted_at ? "deleted" : "active",
    viewport: browser.viewport ?? undefined,
  };
}

export const kernelBrowserProvider: BrowserProvider = {
  name: "kernel",

  async createSession(options: CreateBrowserSessionOptions, signal) {
    const browser = await kernel.browsers.create(
      {
        start_url: options.startUrl,
        stealth: true,
        telemetry: { enabled: true },
        timeout_seconds: options.timeoutSeconds ?? browserTimeoutFloorSeconds,
        viewport: options.viewport,
        ...(options.kernelProfileId === undefined
          ? {}
          : { profile: { id: options.kernelProfileId, save_changes: true } }),
        ...(env.KERNEL_PROXY_ID === undefined
          ? {}
          : { proxy: { id: env.KERNEL_PROXY_ID } }),
      },
      { signal }
    );
    return descriptor(browser);
  },

  async getSession(sessionId, options, signal) {
    const browser = await kernel.browsers.retrieve(
      sessionId,
      { include_deleted: options?.includeDeleted ?? false },
      { signal }
    );
    return descriptor(browser);
  },

  async deleteSession(sessionId, signal) {
    // Deleting is what flushes signed-in cookies into the Kernel profile; the
    // profile itself is the storage state, so nothing is returned here.
    await kernel.browsers.deleteByID(sessionId, { signal });
    return {};
  },

  async executePlaywright(sessionId, request, signal) {
    const response = await kernel.browsers.playwright.execute(
      sessionId,
      { code: request.code, timeout_sec: request.timeoutSec ?? 30 },
      { signal }
    );
    return {
      error: response.error,
      result: response.result,
      success: response.success,
    };
  },

  async stageFile(sessionId, file) {
    await kernel.browsers.fs.writeFile(sessionId, file.bytes, {
      path: file.path,
    });
  },

  async exportStorageState() {
    // Kernel persists login state through profiles, not exported blobs.
    return undefined;
  },

  async withCdpPage(sessionId, operation, signal) {
    return withKernelCdpPage(sessionId, operation, signal);
  },
};
