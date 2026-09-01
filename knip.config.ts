import type { KnipConfig } from "knip";

export default {
  entry: [
    "agent/channels/**/*.ts",
    "agent/hooks/**/*.ts",
    "agent/memory/**/*.ts",
    "agent/subagents/**/*.ts",
    "agent/tools/**/*.ts",
    "db/drizzle.config.ts",
    "evals/**/*.eval.ts",
    "evals/evals.config.ts",
    "taze.config.ts",
  ],
  ignoreDependencies: [
    // Imported through the owning Tailwind stylesheet rather than TypeScript.
    "shadcn",
    "tailwindcss",
    // Loaded as jsPlugins from .oxlintrc.jsonc rather than TypeScript.
    "eslint-plugin-react-hooks",
    "eslint-plugin-turbo",
    "oxlint-tailwindcss",
    // Invoked as a CLI.
    "vercel",
  ],
  ignoreIssues: {
    // Eve AI Elements and shadcn registry primitives intentionally expose
    // a reusable component surface wider than this minimal chat consumes.
    "components/ai-elements/**/*.tsx": ["exports", "files", "types"],
    "components/ui/**/*.tsx": ["exports", "files", "types"],
    // The wire contract is shared with services/browser-gateway, which
    // imports it relatively from outside this knip project.
    "lib/browser/contract.ts": ["exports", "types"],
  },
  // The gateway is its own workspace package with its own tsconfig and tests.
  ignore: ["services/browser-gateway/**"],
  project: [
    "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "!services/browser-gateway/**",
  ],
} satisfies KnipConfig;
