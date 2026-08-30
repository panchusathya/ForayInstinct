import { defineMemory, type MemoryOperationContext } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { buildWorkspaceContextRecall } from "../lib/workspace-context";
import {
  deleteWorkspaceMemory,
  saveWorkspaceMemory,
} from "@/db/services/workspace-memories";

async function recall(ctx: MemoryOperationContext) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) return null;
  try {
    const scope = scopeFromPrincipal(caller);
    const messages = await buildWorkspaceContextRecall(scope);
    return messages.length > 0 ? { messages } : null;
  } catch (error) {
    console.error("[workspace-memory] recall failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      messages: [
        {
          content:
            "Workspace memory was unavailable this turn. Use candidate_profile, candidate_documents, and connected Google tools if you need stored facts.",
          id: "workspace-unavailable",
        },
      ],
    };
  }
}

export default defineMemory({
  description:
    "Durable workspace profile, owned documents, remembered facts, and connected-account context.",
  scope(ctx) {
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    if (!caller) return null;
    try {
      const { userId, workspaceId } = scopeFromPrincipal(caller);
      return [workspaceId, userId];
    } catch {
      return null;
    }
  },
  provider: {
    recall: {
      "turn.started": recall,
      "compaction.completed": recall,
    },
    async tools(ctx) {
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      if (!caller) return null;
      const scope = scopeFromPrincipal(caller);
      return {
        remember: defineTool({
          description:
            "Save one stable fact or preference so later conversations do not ask again. Use a short key such as preferred_name or target_role.",
          inputSchema: z.object({
            key: z.string().min(1).max(80),
            value: z.string().min(1).max(2_000),
          }),
          async execute({ key, value }) {
            return saveWorkspaceMemory(scope, key, value);
          },
        }),
        forget: defineTool({
          description: "Remove one remembered fact by key.",
          inputSchema: z.object({
            key: z.string().min(1).max(80),
          }),
          async execute({ key }) {
            await deleteWorkspaceMemory(scope, key);
            return { forgotten: key };
          },
        }),
      };
    },
  },
});
