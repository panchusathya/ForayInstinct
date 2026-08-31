// Paid AI Gateway catalog slugs — not free-tier fallbacks. Production still
// requires AI_GATEWAY_API_KEY so Vercel does not route onto the free allowance.

// The conversational agent drives the tool loop, so it needs a model that keeps
// tool calls intact across a turn. GLM 5.3 Flash did not: production threw
// AI_MissingToolResultsError with dozens of orphaned tool ids in a single turn,
// answered resume attachments with "'PDF file parts with URLs' functionality not
// supported", and failed the dynamic tool resolver with "Expected a
// JSON-serializable value". Those are the harness losing the model's own output,
// not candidate-specific bugs, so they surfaced as the agent behaving erratically
// rather than as an outage.
export const chatGatewayModel = "anthropic/claude-sonnet-5";

// Browser automation stays on GLM: it is the high-volume, low-judgement half of
// the workload, and its failures in the logs were Kernel request aborts rather
// than mangled tool calls.
export const browserGatewayModel = "zai/glm-5.3-flash";
