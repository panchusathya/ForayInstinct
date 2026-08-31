// Use the full GLM 5.3 Gateway model for both coordinator and browser work.
// The Flash variant was producing malformed high-fan-out tool-call bursts in
// production, which leaves Eve without results it can return to the model.
// Production still requires AI_GATEWAY_API_KEY so Vercel does not route onto
// the free allowance.
export const chatGatewayModel = "zai/glm-5.3";
export const browserGatewayModel = "zai/glm-5.3";
