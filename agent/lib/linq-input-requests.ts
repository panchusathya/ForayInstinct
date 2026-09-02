import { countRecentApplicationExecutionEvents } from "@/db/services/application-executions";
import { eveSessionClient } from "@/lib/eve-client";

/**
 * eve raises `session-limit` prompts when a session crosses its token budget.
 * On iMessage that prompt is a wall of text with buttons that never fire, and
 * the candidate should never have to referee a guardrail. The channel answers
 * it: approve when the run looks healthy, stop when the trace shows a loop.
 */
const SESSION_LIMIT_UNHEALTHY_LOOKBACK_MS = 60 * 60_000;

interface InputRequestLike {
  readonly kind: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
  readonly prompt: string;
  readonly requestId: string;
}

export function sessionLimitRequests<T extends InputRequestLike>(
  requests: readonly T[]
) {
  return requests.filter((request) => request.kind === "session-limit");
}

/** Healthy means no worker was refused as a duplicate in the last hour. */
async function isSessionActivityHealthy(
  rootSessionId: string,
  now = new Date()
) {
  const duplicates = await countRecentApplicationExecutionEvents({
    eventType: "worker.duplicate_blocked",
    rootSessionId,
    since: new Date(now.getTime() - SESSION_LIMIT_UNHEALTHY_LOOKBACK_MS),
  });
  return duplicates === 0;
}

/**
 * Answers every session-limit request in the batch. Returns what was decided
 * so the channel can tell the candidate only when a run was stopped.
 */
export async function resolveSessionLimitPrompt(input: {
  requests: readonly InputRequestLike[];
  sessionId: string;
}): Promise<"approved" | "stopped"> {
  const healthy = await isSessionActivityHealthy(input.sessionId).catch(
    () => true
  );
  const optionId = healthy ? "continue" : "stop";
  await eveSessionClient()
    .sessions.attach(input.sessionId)
    .respond(
      input.requests.map((request) => ({
        optionId,
        requestId: request.requestId,
      }))
    );
  console.info("[linq-session] answered session-limit prompt", {
    decision: optionId,
    request_ids: input.requests.map((request) => request.requestId),
    session_id: input.sessionId,
  });
  return healthy ? "approved" : "stopped";
}

export const sessionStoppedMessage =
  "i stopped that run because it was looping instead of making progress. text me the role again and i'll start it fresh.";

/**
 * Plain text for the prompts that do need the candidate. Buttons are flattened
 * on iMessage, and a reply matching an option label or its number resolves
 * the request, so number the options.
 */
export function renderInputRequestText(request: InputRequestLike) {
  const options = request.options ?? [];
  if (options.length === 0) return request.prompt;
  return [
    request.prompt,
    ...options.map((option, index) => `${String(index + 1)}. ${option.label}`),
    "reply with the number or the word.",
  ].join("\n");
}
