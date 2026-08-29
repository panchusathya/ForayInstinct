import { defineAgent } from "eve";
import { chatGatewayModel } from "@/lib/model-config";

export default defineAgent({
  // Playwright and Chromium resolve package assets at runtime. Keep them
  // external so Vercel traces the executable payload instead of inlining it.
  build: {
    externalDependencies: ["@sparticuz/chromium", "playwright-core", "sucrase"],
  },
  experimental: {
    tasks: true,
  },
  // Keep the chat model session-scoped. A static gateway selection preserves
  // prompt caching and cannot be replaced by a stale workspace DB setting.
  model: chatGatewayModel,
  reasoning: "low",
  compaction: {
    thresholdPercent: 0.7,
  },
});
