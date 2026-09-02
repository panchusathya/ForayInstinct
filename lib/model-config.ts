import { gateway, wrapLanguageModel } from "ai";
import {
  COORDINATOR_MAX_OUTPUT_TOKENS,
  WORKER_MAX_OUTPUT_TOKENS,
  forceMaxOutputTokensMiddleware,
  keepLastPromptImageMiddleware,
} from "@/lib/model-request";

export {
  COORDINATOR_MAX_OUTPUT_TOKENS,
  WORKER_MAX_OUTPUT_TOKENS,
} from "@/lib/model-request";

// Keep routine chat inexpensive while giving browser work a vision-capable
// model that can read the screenshots returned by browser tools. Production
// still requires AI_GATEWAY_API_KEY so Vercel does not route onto the free
// allowance.
export const chatGatewayModel = "alibaba/qwen3.7-flash";
export const browserGatewayModel = "alibaba/qwen3-vl-235b-a22b-instruct";

export const chatLanguageModel = wrapLanguageModel({
  middleware: forceMaxOutputTokensMiddleware(COORDINATOR_MAX_OUTPUT_TOKENS),
  model: gateway(chatGatewayModel),
});

export const browserLanguageModel = wrapLanguageModel({
  middleware: [
    keepLastPromptImageMiddleware(),
    forceMaxOutputTokensMiddleware(WORKER_MAX_OUTPUT_TOKENS),
  ],
  model: gateway(browserGatewayModel),
});
