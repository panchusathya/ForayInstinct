import { defineAgent } from "eve";
import { chatGatewayModel } from "@/lib/model-config";

export default defineAgent({
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
