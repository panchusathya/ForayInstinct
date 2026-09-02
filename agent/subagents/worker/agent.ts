import { defineAgent } from "eve";
import { taskCompletionSchema } from "@/lib/task-completion";
import { browserGatewayModel } from "@/lib/model-config";

export default defineAgent({
  description:
    "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, human-takeover handoff, cleanup, and a concise verified result. Finish every turn with Eve's native final_output matching the agent outputSchema. The parent must not pass a per-call outputSchema.",
  // Browser work reads screenshots, so it uses the dedicated vision model.
  model: browserGatewayModel,
  // The Qwen VL instruct variant is optimized for direct responses rather
  // than extended reasoning traces.
  reasoning: "none",
  // Backstops only. With compaction near 42k a twenty-minute application is
  // roughly 60-120 model calls, so a tighter cap would interrupt a healthy
  // fill; the duplicate guard, the 20-minute watchdog, and the per-call
  // context bound are what actually stop a defective worker.
  limits: {
    maxInputTokensPerSession: 5_000_000,
    maxOutputTokensPerSession: 200_000,
  },
  outputSchema: taskCompletionSchema,
  // The gateway reports a 131,072-token window for this model, but eve never
  // sets maxOutputTokens, so the provider reserves its 65,536 default and the
  // real input ceiling is 65,536. Compaction keys off this value, so it must
  // sit below that ceiling or it never runs before the provider rejects.
  modelContextWindowTokens: 60_000,
  compaction: {
    thresholdPercent: 0.7,
  },
});
