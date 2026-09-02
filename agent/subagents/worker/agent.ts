import { defineAgent } from "eve";
import { taskCompletionSchema } from "@/lib/task-completion";
import { browserLanguageModel } from "@/lib/model-config";

export default defineAgent({
  description:
    'Execute one bounded browser assignment for the root coordinator: find the exact posting on the given ATS URL if needed, then fill the form in the same execution. Includes secure vault autofill, transaction preparation, human-takeover handoff, cleanup, and a concise verified result. A `{ status: "working" }` receipt means this worker is already running — the parent must not start another. Finish every turn with Eve\'s native final_output matching the agent outputSchema. The parent must not pass a per-call outputSchema.',
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
