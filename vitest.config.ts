import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // The browser gateway is its own workspace package with its own vitest
    // config; its tests must not run under the app's Next.js setup.
    exclude: ["**/node_modules/**", "services/browser-gateway/**"],
    setupFiles: ["./tests/setup-env.ts"],
  },
});
