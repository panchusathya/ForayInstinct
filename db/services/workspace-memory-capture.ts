import type { AccessScope } from "@/lib/access-scope";
import {
  extractStatedFacts,
  userMessageTexts,
} from "@/lib/workspace-memory-capture";
import {
  listWorkspaceMemories,
  saveWorkspaceMemory,
} from "./workspace-memories";

const captureOperationKey = "capture.operation";

/**
 * Persists user-stated facts after a settled turn. Idempotent on operationId
 * so a replayed capture does not rewrite the store.
 */
export async function observeWorkspaceConversation(
  scope: AccessScope,
  messages: readonly { readonly content: unknown; readonly role: string }[],
  operationId: string
) {
  const existing = await listWorkspaceMemories(scope);
  if (
    existing.some(
      (entry) =>
        entry.key === captureOperationKey && entry.value === operationId
    )
  ) {
    return { captured: 0, replayed: true };
  }

  const facts = extractStatedFacts(userMessageTexts(messages).join("\n"));
  for (const fact of facts) {
    await saveWorkspaceMemory(scope, fact.key, fact.value);
  }
  await saveWorkspaceMemory(scope, captureOperationKey, operationId);
  return { captured: facts.length, replayed: false };
}
