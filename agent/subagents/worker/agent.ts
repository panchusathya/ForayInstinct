import { defineAgent } from "eve";
import { taskCompletionSchema } from "@/lib/task-completion";
import { browserGatewayModel } from "@/lib/model-config";

export default defineAgent({
  description:
    "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, human-takeover handoff, cleanup, and a concise verified result. Finish every turn with Eve's native final_output matching the agent outputSchema. The parent must not pass a per-call outputSchema.",
  // Browser work stays on the same cheap tool-capable Gateway model as chat.
  model: browserGatewayModel,
  reasoning: "low",
  outputSchema: taskCompletionSchema,
  compaction: {
    thresholdPercent: 0.7,
  },
});
