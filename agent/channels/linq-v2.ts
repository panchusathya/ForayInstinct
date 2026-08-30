/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Eve's Linq adapter exposes the thread through a transitive Chat SDK type; TypeScript still checks this contextual handler. */
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
import { formatCandidateDelivery } from "@/lib/goforay/delivery";
import {
  goForayJobCardSchema,
  jobCardFilename,
  renderGoForayJobCard,
  type GoForayJobCard,
} from "@/lib/goforay/job-cards";
import { createPostgresState } from "@/lib/linq-state";
import { consumeWorkerCancellationTurn } from "../lib/worker-cancellation-delivery";
import { consumeLatestApplicationSubmissionScreenshot } from "@/db/services/application-submission-screenshots";
import {
  linkCandidate,
  goforayJobCardPng,
  recordConversationMessage,
} from "@/lib/goforay/bridge";
import { saveCandidateDocument } from "@/db/services/candidate-documents";
import { inferCandidateDocumentKind } from "@/lib/candidate-documents";

const verifiedPhoneUserSchema = z.object({
  id: z.string().min(1),
  phoneNumberVerified: z.literal(true),
  phoneNumber: z.string().min(1),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  name: z.string().optional(),
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
const applicationStartResultSchema = z.object({
  kind: z.literal("tool-result"),
  toolName: z.literal("start_goforay_application"),
});
const submittedApplicationResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z.object({ status: z.literal("submitted") }),
  toolName: z.literal("report_goforay_application_result"),
});
const jobCardResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z.object({ cards: z.array(goForayJobCardSchema) }),
  toolName: z.enum(["find_goforay_roles", "find_next_goforay_roles"]),
});
const pendingJobCardsSchema = z.object({
  cards: z.array(goForayJobCardSchema),
  turnId: z.string(),
});
const pendingSubmissionScreenshotSchema = z.object({
  turnId: z.string(),
});

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
      const sourceMessageId = context.thread?.toJSON().currentMessage?.id;
      if (applicationStartResultSchema.safeParse(event.result).success) {
        void reactToCurrentMessage(
          context,
          sourceMessageId,
          "👀",
          "application-start"
        );
      }
      if (submittedApplicationResultSchema.safeParse(event.result).success) {
        context.state.pendingSubmissionScreenshot = {
          turnId: event.turnId,
        };
        void reactToCurrentMessage(
          context,
          sourceMessageId,
          "✅",
          "application-submitted"
        );
      }
      const jobCards = jobCardResultSchema.safeParse(event.result);
      if (jobCards.success) {
        const cards = jobCards.data.output.cards
          .filter((card) => card.url)
          .slice(0, 5);
        if (cards.length) {
          context.state.pendingGoForayJobCards = {
            cards,
            turnId: event.turnId,
          };
        }
      }
      if (!result.success) return;

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
        return;
      }

      const cancelledTaskId = consumeWorkerCancellationTurn(
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
      if (!context.thread) return;

      const pendingScreenshot = pendingSubmissionScreenshotSchema.safeParse(
        context.state.pendingSubmissionScreenshot
      );
      if (
        pendingScreenshot.success &&
        pendingScreenshot.data.turnId === event.turnId
      ) {
        context.state.pendingSubmissionScreenshot = undefined;
        const caller =
          session.session.auth?.current ?? session.session.auth?.initiator;
        if (caller) {
          await deliverSubmissionScreenshot(
            context.thread,
            scopeFromPrincipal(caller),
            event.turnId
          );
        }
      }

      if (!event.message) return;

      const pendingCards = pendingJobCardsSchema.safeParse(
        context.state.pendingGoForayJobCards
      );
      if (pendingCards.success && pendingCards.data.turnId === event.turnId) {
        context.state.pendingGoForayJobCards = undefined;
        const caller =
          session.session.auth?.current ?? session.session.auth?.initiator;
        await deliverJobCards(
          context.thread,
          pendingCards.data.cards,
          caller ? scopeFromPrincipal(caller) : undefined,
          event.turnId
        );
        return;
      }

      const delivery = formatCandidateDelivery(event.message);
      if (!delivery.bubbles.length) return;
      for (const [index, body] of delivery.bubbles.entries()) {
        // Eve's Linq adapter translates supported Markdown into native iMessage
        // decorations, so recipients see styled text instead of literal markers.
        await context.thread.post({ markdown: body });
        const caller =
          session.session.auth?.current ?? session.session.auth?.initiator;
        if (caller) {
          const scope = scopeFromPrincipal(caller);
          void recordConversationMessage({
            scope,
            conversationId: `linq:${scope.userId}`,
            channel: "linq",
            direction: "outbound",
            body,
            sourceMessageId: `linq:${event.turnId}:${index}`,
          }).catch(() => undefined);
        }
      }
      if (delivery.reaction) {
        await reactToCurrentMessage(
          context,
          sourceMessageId,
          delivery.reaction === "heart" ? "❤️" : "Haha",
          `semantic-${delivery.reaction}`
        );
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
  throw new Error(
    "Configure LINQ_API_KEY and LINQ_WEBHOOK_SECRET or LINQ_CONNECTOR."
  );
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
  const verifiedUser = phoneNumber
    ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
    : undefined;
  if (verifiedUser && phoneNumber) {
    try {
      await linkCandidate({
        userId: verifiedUser.id,
        name: verifiedUser.name ?? "",
        identities: [
          { kind: "phone", value: phoneNumber, verified: true },
          ...(verifiedUser.emailVerified && verifiedUser.email
            ? [
                {
                  kind: "email" as const,
                  value: verifiedUser.email,
                  verified: true as const,
                },
              ]
            : []),
        ],
      });
    } catch {
      // A missing or ambiguous CRM candidate must not block a normal text.
    }
  }
  const principalId = verifiedUser
    ? `better-auth:${verifiedUser.id}`
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
      sourceMessageId: message.id,
    }).catch(() => undefined);
  }
  return {
    context: [
      CURRENT_FORAY_POLICY,
      ...(importedResumes.length
        ? [
            `The candidate attached a document. It is stored in this workspace (${importedResumes.join(", ")}). Use it for applications and do not ask them to upload it again or expose the file contents.`,
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
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      const result = await saveCandidateDocument(scope, {
        bytes,
        filename,
        kind: inferCandidateDocumentKind(filename),
        mimeType: mimeType || response.headers.get("content-type") || "",
        setDefault: true,
        source: "linq",
      });
      uploaded.push(result.document.filename);
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
  return parsed.success ? parsed.data : undefined;
}

async function reactToCurrentMessage(
  context: {
    bot: {
      getAdapter: (name: "linq") => {
        addReaction: (
          threadId: string,
          messageId: string,
          emoji: string
        ) => Promise<void>;
      };
    };
    state: Record<string, unknown>;
    thread?: { id: string };
  },
  messageId: string | undefined,
  emoji: string,
  reason: string
) {
  if (!messageId || !context.thread) return;
  const key = `forayReaction:${reason}:${messageId}`;
  if (context.state[key]) return;
  try {
    await context.bot
      .getAdapter("linq")
      .addReaction(context.thread.id, messageId, emoji);
    context.state[key] = true;
  } catch {
    // SMS/RCS and web paths do not guarantee reaction support.
  }
}

async function deliverSubmissionScreenshot(
  thread: {
    post: (message: {
      markdown: string;
      files?: { data: Buffer; filename: string; mimeType: string }[];
    }) => Promise<unknown>;
    toJSON: () => unknown;
  },
  scope: ReturnType<typeof scopeFromPrincipal>,
  turnId: string
) {
  if (!isRichLinqThread(thread)) return;
  try {
    const screenshot =
      await consumeLatestApplicationSubmissionScreenshot(scope);
    if (!screenshot) return;
    await thread.post({
      markdown: "",
      files: [
        {
          data: screenshot.png,
          filename: "application-submitted.png",
          mimeType: screenshot.mimeType,
        },
      ],
    });
    void recordConversationMessage({
      scope,
      conversationId: `linq:${scope.userId}`,
      channel: "linq",
      direction: "outbound",
      body: "application submitted screenshot",
      sourceMessageId: `linq:${turnId}:submission-screenshot`,
    }).catch(() => undefined);
  } catch {
    // The coordinator's text confirmation remains useful if media upload fails.
  }
}

async function deliverJobCards(
  thread: {
    post: (message: {
      markdown: string;
      files?: { data: Buffer; filename: string; mimeType: string }[];
    }) => Promise<unknown>;
    toJSON: () => unknown;
  },
  cards: GoForayJobCard[],
  scope: ReturnType<typeof scopeFromPrincipal> | undefined,
  turnId: string
) {
  const rich = isRichLinqThread(thread);
  for (const [offset, card] of cards.entries()) {
    const index = offset + 1;
    const text = renderGoForayJobCard(card, index, cards.length);
    let sentImage = false;
    if (rich && scope && card.posting_id) {
      try {
        const png = await goforayJobCardPng(
          scope,
          card.posting_id,
          index,
          cards.length
        );
        await thread.post({
          markdown: text,
          files: [
            {
              data: png,
              filename: jobCardFilename(card),
              mimeType: "image/png",
            },
          ],
        });
        sentImage = true;
      } catch {
        // The text card remains useful if rendering or media upload is unavailable.
      }
    }
    if (!sentImage) await thread.post({ markdown: text });
    if (scope) {
      void recordConversationMessage({
        scope,
        conversationId: `linq:${scope.userId}`,
        channel: "linq",
        direction: "outbound",
        body: text,
        sourceMessageId: `linq:${turnId}:card:${index}`,
      }).catch(() => undefined);
    }
  }
}

function isRichLinqThread(thread: { toJSON: () => unknown }) {
  const value = z
    .object({
      lastService: z.string().optional(),
      service: z.string().optional(),
    })
    .safeParse(thread.toJSON());
  const service = value.success
    ? (value.data.lastService ?? value.data.service ?? "")
    : "";
  return service === "iMessage" || service === "RCS";
}
