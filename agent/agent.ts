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
  // A chat thread is one session for as long as the candidate keeps texting,
  // so any lifetime cap eventually trips on healthy use and starves the
  // worker dispatched near the end (children inherit the parent's remaining
  // quota). The coordinator is bounded per call by compaction below and per
  // turn by agent/hooks/turn-budget.ts instead.
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
  },
  // The gateway reports a 991k window for this model, which would let one
  // call carry ~700k tokens of history before compaction. Workspace memory
  // already carries stable facts across compactions, so keep the working
  // context small: compaction triggers near 84k.
  modelContextWindowTokens: 120_000,
  compaction: {
    thresholdPercent: 0.7,
  },
});
