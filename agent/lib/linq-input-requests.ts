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
  // The option ids are the prompt's own, read off each request. Hardcoded
  // "continue" and "stop" answered a prompt whose options were named
  // otherwise with ids it did not have, and the session sat on it unseen.
  const responses = input.requests.flatMap((request) => {
    const optionId = sessionLimitOptionId(request, healthy);
    return optionId === undefined
      ? []
      : [{ optionId, requestId: request.requestId }];
  });
  if (responses.length > 0) {
    await eveSessionClient()
      .sessions.attach(input.sessionId)
      .respond(responses);
  }
  console.info("[linq-session] answered session-limit prompt", {
    decision: healthy ? "approve" : "stop",
    request_ids: responses.map((response) => response.requestId),
    session_id: input.sessionId,
    unanswered: input.requests.length - responses.length,
  });
  return healthy ? "approved" : "stopped";
}

/** The request's own id for approving or stopping, by label first, then id. */
function sessionLimitOptionId(request: InputRequestLike, approve: boolean) {
  const options = request.options ?? [];
  if (options.length === 0) return undefined;
  const wording = approve
    ? /continue|approve|keep|proceed|yes|allow/iu
    : /stop|cancel|halt|end|no\b|deny/iu;
  const named = options.find(
    (option) => wording.test(option.label) || wording.test(option.id)
  );
  return (named ?? (approve ? options[0] : options.at(-1)))?.id;
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
