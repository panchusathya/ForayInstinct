import { defineConfig } from "vitest/config";

// A local config so vitest does not walk up and inherit the repo root's
// Next.js-oriented setup (setup files, aliases) that do not exist here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
