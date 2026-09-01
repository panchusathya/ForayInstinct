// Keep routine chat inexpensive while giving browser work a vision-capable
// model that can read the screenshots returned by browser tools. Production
// still requires AI_GATEWAY_API_KEY so Vercel does not route onto the free
// allowance.
export const chatGatewayModel = "alibaba/qwen3.7-flash";
export const browserGatewayModel = "alibaba/qwen3-vl-235b-a22b-instruct";
