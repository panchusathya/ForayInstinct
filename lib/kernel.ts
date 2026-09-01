import Kernel from "@onkernel/sdk";
import { env } from "@/lib/env";

// KERNEL_API_KEY is optional when BROWSER_PROVIDER is "gateway" (lib/env.ts
// enforces it for "kernel"); the placeholder keeps this module importable
// without a key, and no Kernel call is ever made on the gateway path.
export const kernel = new Kernel({
  apiKey: env.KERNEL_API_KEY ?? "unconfigured",
});
