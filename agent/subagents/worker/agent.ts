import { defineAgent } from "eve";
import { taskCompletionSchema } from "@/lib/task-completion";
import { browserGatewayModel } from "@/lib/model-config";

export default defineAgent({
  description:
    "Execute one bounded browser assignment for the root coordinator, including secure vault autofill, transaction preparation, human-takeover handoff, cleanup, and a concise verified result. Every initial and resumed call must include the task-completion outputSchema required by the root instructions.",
  // Browser work benefits from the stronger tool-use model, while normal chat
  // stays on Luna Fast.
  model: browserGatewayModel,
  reasoning: "low",
  outputSchema: taskCompletionSchema,
  compaction: {
    thresholdPercent: 0.7,
  },
});
