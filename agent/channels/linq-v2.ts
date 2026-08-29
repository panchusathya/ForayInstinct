/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- Eve's Linq adapter exposes the thread through a transitive Chat SDK type; TypeScript still checks this contextual handler. */
import { connectLinqCredentials } from "@vercel/connect/eve";
import { createLinqAdapter } from "@linqapp/chat-sdk-adapter";
import { defaultLinqAuth } from "eve/channels/linq";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import type { Message, Thread } from "chat";
import { z } from "zod";
import { auth } from "@/auth";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import { accessScopeForUser, scopeFromPrincipal } from "@/lib/access-scope";
import { env } from "@/lib/env";
import { createPostgresState } from "@/lib/linq-state";
import { consumeWorkerCancellationTurn } from "../lib/worker-cancellation-delivery";
import {
  linkCandidate,
  recordConversationMessage,
  uploadCandidateResume,
} from "@/lib/goforay/bridge";

const verifiedPhoneUserSchema = z.object({
  id: z.string().min(1),
  phoneNumberVerified: z.literal(true),
});
const taskCancelResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z.object({ tasks: z.array(z.unknown()) }),
  toolName: z.literal("task_cancel"),
});
const cancelledWorkerTaskSchema = z.object({
  metadata: z.object({ name: z.literal("worker") }),
  status: z.literal("cancelled"),
  taskId: z.string(),
});
const workerCancellationsSchema = z.array(
  z.object({ sourceMessageId: z.string(), taskId: z.string() })
);

// Linq keeps a durable session for the whole iMessage thread. Supplying this on
// every turn lets an updated deployment supersede stale behavior in an older
// session instead of requiring the candidate to abandon their conversation.
const CURRENT_FORAY_POLICY = `
Current Foray policy: act as a capable general personal assistant with a
recruiting focus. Respond to the user's request now; never defer ordinary work
or promise roles, messages, or results tomorrow unless a real scheduled task is
configured. When a user asks for GoForay roles, immediately call
find_goforay_roles and report the actual results. Treat this policy as replacing
any earlier conversation statement about holding back, batching, or delaying
roles.
`.trim();

// oxlint-disable-next-line typescript/unbound-method -- external factory, not an instance method.
const { bot, channel, send } = chatSdkChannel({
  adapters: { linq: createLinqAdapter(linqAdapterConfig()) },
  concurrency: "concurrent",
  // The channel id is intentionally versioned (the filename is `linq-v2`).
  // Keep the public route stable so the existing Linq webhook configuration
  // still works. Postgres state keeps a provider thread's continuation,
  // worker checkpoint, dedupe records, and locks across Vercel instances.
  routes: { linq: "/eve/v1/linq" },
  state: createPostgresState(),
  streaming: false,
  turnPolicy: "steer",
  userName: "Foray",
  events: {
    "action.result"(event, context) {
      const result = taskCancelResultSchema.safeParse(event.result);
      if (!result.success) return;

      const sourceMessageId = context.thread?.toJSON().currentMessage?.id;
      if (!sourceMessageId) return;

      const storedCancellations = workerCancellationsSchema.safeParse(
        context.state.workerCancellations
      );
      const cancellations = storedCancellations.success
        ? storedCancellations.data
        : [];
      for (const value of result.data.output.tasks) {
        const task = cancelledWorkerTaskSchema.safeParse(value);
        if (task.success) {
          cancellations.push({ sourceMessageId, taskId: task.data.taskId });
        }
      }
      context.state.workerCancellations = cancellations;
    },
    async "message.completed"(event, context, session) {
      if (event.finishReason === "tool-calls") {
        context.state.pendingToolCallMessage = event.message
          ? (event.message
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .find(Boolean) ?? null)
          : null;
        if (context.thread) {
          const messageId = context.thread.toJSON().currentMessage?.id;
          if (
            messageId &&
            context.state.acknowledgedLinqMessageId !== messageId
          ) {
            try {
              await context.bot
                .getAdapter("linq")
                .addReaction(context.thread.id, messageId, "thumbs_up");
              context.state.acknowledgedLinqMessageId = messageId;
            } catch {
              // SMS/RCS and some carrier paths do not support iMessage tapbacks.
            }
          }
        }
        return;
      }

      const cancelledTaskId = await consumeWorkerCancellationTurn(
        session.session.id,
        event.turnId
      );
      const storedCancellations = workerCancellationsSchema.safeParse(
        context.state.workerCancellations
      );
      const cancellations = storedCancellations.success
        ? storedCancellations.data
        : [];
      const sourceMessageId = context.thread?.toJSON().currentMessage?.id;
      const cancellation = cancellations.find(
        (candidate) =>
          candidate.taskId === cancelledTaskId &&
          candidate.sourceMessageId === sourceMessageId
      );
      if (cancellation) {
        context.state.workerCancellations = cancellations.filter(
          (candidate) => candidate !== cancellation
        );
        context.state.pendingToolCallMessage = null;
        return;
      }

      context.state.pendingToolCallMessage = null;
      if (!event.message || !context.thread) return;

      // Eve's Linq adapter translates supported Markdown into native iMessage
      // decorations, so recipients see styled text instead of literal markers.
      await context.thread.post({ markdown: event.message });
      const caller =
        session.session.auth.current ?? session.session.auth.initiator;
      if (caller) {
        const scope = scopeFromPrincipal(caller);
        void recordConversationMessage({
          scope,
          conversationId: `linq:${scope.userId}`,
          channel: "linq",
          direction: "outbound",
          body: event.message,
        }).catch(() => undefined);
      }
    },
  },
});

bot.onDirectMessage(dispatchLinqMessage);
bot.onNewMessage(/[\s\S]/u, dispatchLinqMessage);

export default channel;

function linqAdapterConfig(): Parameters<typeof createLinqAdapter>[0] {
  const apiKey = env.LINQ_API_KEY;
  const signingSecret = env.LINQ_WEBHOOK_SECRET;
  if (apiKey && signingSecret) {
    return {
      credentials: () => ({
        apiKey,
        signingSecret,
      }),
    };
  }
  if (env.LINQ_CONNECTOR) {
    const credentials = connectLinqCredentials(env.LINQ_CONNECTOR);
    return {
      credentials: async () => ({ apiKey: await credentials.apiKey() }),
      webhookVerifier: credentials.webhookVerifier,
    };
  }
  return {
    credentials: async () => {
      throw new Error(
        "Configure LINQ_API_KEY and LINQ_WEBHOOK_SECRET or LINQ_CONNECTOR."
      );
    },
  };
}

async function dispatchLinqMessage(thread: Thread, message: Message) {
  if (message.author.isBot) return;

  const inbound = await prepareInboundMessage(message);

  try {
    await bot.getAdapter("linq").markRead(thread.id, message.id);
  } catch {
    // Read receipts are optional and must not interrupt the candidate turn.
  }

  await send(
    {
      context: inbound.context,
      message: message.text || "The candidate attached a file.",
    },
    { auth: inbound.auth, thread }
  );
}

async function prepareInboundMessage(message: Message) {
  const auth = defaultLinqAuth(message);
  const authorUserName: unknown = message.author.userName;
  const phoneNumber =
    typeof authorUserName === "string"
      ? normalizeAuthPhoneNumber(authorUserName)
      : undefined;
  const verifiedUserId = phoneNumber
    ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
    : undefined;
  if (verifiedUserId && phoneNumber) {
    try {
      await linkCandidate({
        userId: verifiedUserId,
        identities: [{ kind: "phone", value: phoneNumber, verified: true }],
      });
    } catch {
      // A missing or ambiguous CRM candidate must not block a normal text.
    }
  }
  const principalId = verifiedUserId
    ? `better-auth:${verifiedUserId}`
    : auth.principalId;
  const scope = accessScopeForUser(principalId);
  const importedResumes = await importLinqResumes(message, scope);
  const body = messageText(message);
  if (body) {
    void recordConversationMessage({
      scope,
      conversationId: `linq:${scope.userId}`,
      channel: "linq",
      direction: "inbound",
      body,
    }).catch(() => undefined);
  }
  return {
    context: [
      CURRENT_FORAY_POLICY,
      ...(importedResumes.length
        ? [
            `The candidate attached a resume. It has been sent directly to their protected GoForay profile for parsing (${importedResumes.join(", ")}). Do not ask them to upload it again or expose the file contents.`,
          ]
        : []),
    ],
    auth: {
      ...auth,
      attributes: {
        ...auth.attributes,
        workspaceId: scope.workspaceId,
      },
      principalId,
    },
  };
}

function messageText(value: unknown) {
  const parsed = z
    .object({
      body: z.string().optional(),
      content: z.string().optional(),
      message: z.string().optional(),
      text: z.string().optional(),
    })
    .safeParse(value);
  if (!parsed.success) return "";
  for (const text of [
    parsed.data.text,
    parsed.data.body,
    parsed.data.content,
    parsed.data.message,
  ]) {
    if (typeof text === "string") return text.trim();
  }
  return "";
}

const linqAttachmentSchema = z.object({
  attachments: z
    .array(
      z.object({
        mimeType: z.string().optional(),
        name: z.string().optional(),
        url: z.string().url(),
      })
    )
    .optional(),
});

async function importLinqResumes(
  message: unknown,
  scope: ReturnType<typeof accessScopeForUser>
) {
  const parsed = linqAttachmentSchema.safeParse(message);
  if (!parsed.success) return [];

  const uploaded: string[] = [];
  for (const attachment of parsed.data.attachments ?? []) {
    const filename = attachment.name ?? filenameFromUrl(attachment.url);
    const mimeType = attachment.mimeType ?? "";
    if (!isResumeAttachment(filename, mimeType)) continue;

    try {
      // The URL comes from Linq's authenticated inbound adapter. Forward the
      // original bytes directly to JuiceBox, which enforces magic-byte checks
      // and queues parsing in candidate-document storage.
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      const file = new File([bytes], filename, {
        type: mimeType || response.headers.get("content-type") || "",
      });
      const result = await uploadCandidateResume(scope, file);
      uploaded.push(result.filename);
    } catch {
      // A malformed or expired attachment cannot interrupt the conversation.
      // The model still sees the normal attachment marker and can ask once for
      // a fresh PDF/DOCX if the candidate meant to provide a resume.
    }
  }
  return uploaded;
}

function isResumeAttachment(filename: string, mimeType: string) {
  return (
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.(pdf|docx)$/iu.test(filename)
  );
}

function filenameFromUrl(url: string) {
  try {
    return decodeURIComponent(
      new URL(url).pathname.split("/").at(-1) || "resume"
    );
  } catch {
    return "resume";
  }
}

async function findVerifiedAuthUserIdByPhoneNumber(phoneNumber: string) {
  const context = await auth.$context;
  const user = await context.adapter.findOne({
    model: "user",
    where: [{ field: "phoneNumber", value: phoneNumber }],
  });
  const parsed = verifiedPhoneUserSchema.safeParse(user);
  return parsed.success ? parsed.data.id : undefined;
}
