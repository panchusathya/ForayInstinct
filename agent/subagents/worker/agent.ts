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
  outputSchema: taskCompletionSchema,
  compaction: {
    thresholdPercent: 0.7,
  },
});
