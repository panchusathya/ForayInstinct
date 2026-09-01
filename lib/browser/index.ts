import { gatewayBrowserProvider } from "@/lib/browser/gateway-provider";
import { kernelBrowserProvider } from "@/lib/browser/kernel-provider";
import type { BrowserProvider } from "@/lib/browser/provider";
import { env } from "@/lib/env";

export { isGatewayProvider } from "@/lib/browser/provider";
export type {
  BrowserProvider,
  BrowserSessionDescriptor,
  CdpPageHandle,
} from "@/lib/browser/provider";

/**
 * The active browser backend. `BROWSER_PROVIDER=kernel` (default) keeps
 * Kernel-hosted sessions; `gateway` routes through the Brightdata browser
 * gateway service. Flipping the variable is the rollout and rollback switch.
 */
export const browserProvider: BrowserProvider =
  env.BROWSER_PROVIDER === "gateway"
    ? gatewayBrowserProvider
    : kernelBrowserProvider;
