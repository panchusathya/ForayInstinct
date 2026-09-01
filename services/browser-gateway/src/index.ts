import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { brightdataEndpoint, loadEnv } from "./env.ts";
import { SessionRegistry } from "./registry.ts";

export function main(): void {
  const env = loadEnv();
  const registry = new SessionRegistry(brightdataEndpoint(env));
  const app = createApp({ authSecret: env.authSecret, sessions: registry });
  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`browser-gateway listening on :${String(info.port)}`);
  });
  const shutdown = () => {
    server.close();
    registry
      .closeAll()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Main-guard: boot only when run directly, so tests can import createApp
// and friends without starting a server.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
