import { NextResponse } from "next/server";
import {
  agentSessions,
  browserSessions,
  chatStateLocks,
  chatStateQueue,
  chatStateSubscriptions,
  chatStateValues,
  chats,
  db,
  goforayConversations,
} from "@/db";
import { env } from "@/lib/env";
import { kernel } from "@/lib/kernel";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const suppliedToken = request.headers.get("x-agent-state-reset-token");
  if (
    env.AGENT_STATE_RESET_TOKEN === undefined ||
    suppliedToken !== env.AGENT_STATE_RESET_TOKEN
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const remoteBrowsers = await db
    .select({ sessionId: browserSessions.sessionId })
    .from(browserSessions);
  const remoteResults = await Promise.allSettled(
    remoteBrowsers.map(({ sessionId }) => kernel.browsers.deleteByID(sessionId))
  );

  const counts = await db.transaction(async (tx) => {
    const [
      queue,
      locks,
      subscriptions,
      values,
      browsers,
      chatRows,
      sessions,
      conversations,
    ] = await Promise.all([
      tx
        .delete(chatStateQueue)
        .returning({ sequence: chatStateQueue.sequence }),
      tx
        .delete(chatStateLocks)
        .returning({ threadId: chatStateLocks.threadId }),
      tx
        .delete(chatStateSubscriptions)
        .returning({ threadId: chatStateSubscriptions.threadId }),
      tx.delete(chatStateValues).returning({ key: chatStateValues.key }),
      tx
        .delete(browserSessions)
        .returning({ sessionId: browserSessions.sessionId }),
      tx.delete(chats).returning({ sessionId: chats.sessionId }),
      tx
        .delete(agentSessions)
        .returning({ sessionId: agentSessions.sessionId }),
      tx
        .delete(goforayConversations)
        .returning({ id: goforayConversations.id }),
    ]);

    return {
      agentSessions: sessions.length,
      browserSessions: browsers.length,
      chats: chatRows.length,
      chatStateLocks: locks.length,
      chatStateQueue: queue.length,
      chatStateSubscriptions: subscriptions.length,
      chatStateValues: values.length,
      goforayConversations: conversations.length,
    };
  });

  return NextResponse.json({
    database: counts,
    kernelBrowsers: {
      deleted: remoteResults.filter((result) => result.status === "fulfilled")
        .length,
      failed: remoteResults.filter((result) => result.status === "rejected")
        .length,
      found: remoteBrowsers.length,
    },
  });
}
