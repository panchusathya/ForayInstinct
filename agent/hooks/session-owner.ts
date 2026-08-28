import { defineHook, type HookContext } from "eve/hooks";
import { saveChat } from "@/db/services/chats";
import { ensureScope } from "@/db/services/scope";
import { claimSession } from "@/db/services/sessions";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { env } from "@/lib/env";
import { recordConversationMessage } from "@/lib/goforay/bridge";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      const initiator = ctx.session.auth.initiator;
      if (!initiator) return;

      const scope = scopeFromPrincipal(initiator);
      await ensureScope(scope);
      await claimSession(scope, ctx.session.id);
    },
    async "message.received"(event, ctx) {
      const initiator = ctx.session.auth.initiator;
      if (!initiator) return;

      await saveChat(scopeFromPrincipal(initiator), {
        sessionId: ctx.session.id,
      });
      if (typeof event.data?.message === "string") {
        await recordWebMessage(ctx, "inbound", event.data.message);
      }
    },
    async "message.completed"(event, ctx) {
      if (event.data.finishReason === "tool-calls" || !event.data.message)
        return;
      await recordWebMessage(ctx, "outbound", event.data.message);
    },
  },
});

async function recordWebMessage(
  ctx: HookContext,
  direction: "inbound" | "outbound",
  body: string
) {
  // Linq persists its own transport events below its channel adapter. Hooks
  // are global, so keeping this to the web channel prevents double records.
  if (ctx.channel.kind === "linq" || !body.trim()) return;
  const initiator = ctx.session.auth.initiator;
  if (!initiator) return;
  try {
    const scope = scopeFromPrincipal(initiator);
    await recordConversationMessage({
      scope,
      conversationId: `web:${ctx.session.id}`,
      channel: "web",
      direction,
      body,
      url: new URL(
        `/chat/${encodeURIComponent(ctx.session.id)}`,
        env.BETTER_AUTH_URL
      ).toString(),
    });
  } catch {
    // A missing GoForay link must never fail an ordinary OpenInstinct chat.
  }
}
