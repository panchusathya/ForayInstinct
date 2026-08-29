import { defineAgent } from "eve";
import { chatGatewayModel } from "@/lib/model-config";

export default defineAgent({
  // Playwright resolves its own package manifest at runtime. Keep the browser
  // runtime packages external so Vercel traces their package files instead of
  // inlining them into the Eve handler.
  build: {
    externalDependencies: ["playwright-core", "sucrase"],
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
