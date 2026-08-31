import { browserSessionNotOwnedMessage } from "@/agent/subagents/worker/lib/challenge-diagnostics";
import { readBrowserSession } from "@/db/services/browsers";
import type { AccessScope } from "@/lib/access-scope";

export async function requireOwnedBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  const record = await readBrowserSession(scope, sessionId);
  // This reads only the local row, so a miss means the session was never
  // recorded for this workspace or has already been reconciled away — Kernel
  // is not consulted. describeBrowserSessionFailure keys off this exact text.
  if (!record) throw new Error(browserSessionNotOwnedMessage);
  return record;
}
