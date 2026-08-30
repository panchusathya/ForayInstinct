/* eslint-disable no-restricted-properties -- this runs before Next's env module can load. */
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Preview deployments must never run a production database migration. They
// validate the app build in isolation, while production fails early if its
// migration connection was not configured.
if (process.env.VERCEL_ENV === "production") {
  if (!process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for production migrations.");
  }
  run("pnpm", ["db:migrate"]);
}

run("pnpm", ["build:app"]);
