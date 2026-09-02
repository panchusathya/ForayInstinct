import { defineAgent } from "eve";
import { taskCompletionSchema } from "@/lib/task-completion";
import { browserLanguageModel } from "@/lib/model-config";

export default defineAgent({
  description:
    "Retired. Job filling uses start_application / continue_application / cancel_application. Do not spawn this subagent.",
  // Browser work reads screenshots, so it uses the dedicated vision model.
  model: browserLanguageModel,
  // The Qwen VL instruct variant is optimized for direct responses rather
  // than extended reasoning traces.
  reasoning: "none",
  // Backstops only. Per-call maxOutputTokens is 2k via wrapLanguageModel, so
  // the provider no longer reserves 65,536. Compaction near 32k, the
  // application lease, and the 20-minute watchdog stop a defective worker.
  limits: {
    maxInputTokensPerSession: 5_000_000,
    maxOutputTokensPerSession: 200_000,
  },
  outputSchema: taskCompletionSchema,
  // With a 2k output cap the 131,072-token window is actually usable. Compact
  // near 32k so screenshot history is stubbed before the fill loop balloons.
  modelContextWindowTokens: 80_000,
  compaction: {
    thresholdPercent: 0.4,
  },
});
