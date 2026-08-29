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
        await recordWebMessage(
          ctx,
          "inbound",
          event.data.message,
          event.meta.id
        );
      }
    },
    async "message.completed"(event, ctx) {
      if (event.data.finishReason === "tool-calls" || !event.data.message)
        return;
      await recordWebMessage(
        ctx,
        "outbound",
        event.data.message,
        event.meta.id
      );
    },
  },
});

async function recordWebMessage(
  ctx: HookContext,
  direction: "inbound" | "outbound",
  body: string,
  sourceMessageId: string
) {
  const initiator = ctx.session.auth.initiator;
  // Linq uses the shared Chat SDK channel, whose runtime kind is `chat-sdk`
  // rather than `linq`. The auth projection is the durable discriminator.
  // Linq records its own transport messages in the channel adapter, so the
  // global hook must not mirror them into a second web conversation.
  if (initiator?.authenticator === "linq-message" || !body.trim()) return;
  if (!initiator) return;
  try {
    const scope = scopeFromPrincipal(initiator);
    await recordConversationMessage({
      scope,
      conversationId: `web:${ctx.session.id}`,
      channel: "web",
      direction,
      body,
      sourceMessageId,
      url: new URL(
        `/chat/${encodeURIComponent(ctx.session.id)}`,
        env.BETTER_AUTH_URL
      ).toString(),
    });
  } catch {
    // A missing GoForay link must never fail an ordinary OpenInstinct chat.
  }
}
