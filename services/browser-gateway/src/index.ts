import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { brightdataEndpoint, loadEnv } from "./env.ts";
import { errorStack, errorSummary, log, logError } from "./log.ts";
import { SessionRegistry } from "./registry.ts";

/**
 * Railway's edge keeps its upstream connections open between requests. Node
 * closes an idle keep-alive socket after 5s by default, and a request the
 * edge sends down a socket Node has just closed is answered with a bare 502
 * that never reaches this process. The app's first script arrives a few
 * seconds after session create, squarely in that window. Node insists the
 * headers timeout stay above the keep-alive timeout.
 */
const keepAliveTimeoutMs = 65_000;
const headersTimeoutMs = 70_000;

export function main(): void {
  const env = loadEnv();
  const registry = new SessionRegistry(brightdataEndpoint(env));
  const app = createApp({ authSecret: env.authSecret, sessions: registry });
  const server = serve(
    {
      fetch: app.fetch,
      port: env.port,
      serverOptions: {
        headersTimeout: headersTimeoutMs,
        keepAliveTimeout: keepAliveTimeoutMs,
      },
    },
    (info) => {
      log("gateway.listening", { port: info.port });
    }
  );
  const shutdown = (signal: string) => {
    log("gateway.shutdown", { sessions: registry.size, signal });
    server.close();
    registry
      .closeAll()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  // Node's default on an unowned rejection is to exit with no line of ours,
  // and Railway restarts the container: from the app that looks like a bare
  // 502 on whichever request was in flight. The process still exits (its
  // state is suspect), but it names the cause first.
  process.on("unhandledRejection", (reason) => {
    logError("gateway.unhandled_rejection", {
      reason: errorSummary(reason),
      sessions: registry.size,
      stack: errorStack(reason),
    });
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    logError("gateway.uncaught_exception", {
      reason: errorSummary(error),
      sessions: registry.size,
      stack: errorStack(error),
    });
    process.exit(1);
  });
}

// Main-guard: boot only when run directly, so tests can import createApp
// and friends without starting a server.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
