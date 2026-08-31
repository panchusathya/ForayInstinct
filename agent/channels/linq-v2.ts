/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Eve's Linq adapter exposes the thread through a transitive Chat SDK type; TypeScript still checks this contextual handler. */
import { connectLinqCredentials } from "@vercel/connect/eve";
import { createLinqAdapter } from "@linqapp/chat-sdk-adapter";
import { defaultLinqAuth } from "eve/channels/linq";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import type { Message, Thread } from "chat";
import { z } from "zod";
import { auth } from "@/auth";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import {
  accessScopeForPhone,
  accessScopeForUser,
  scopeFromPrincipal,
} from "@/lib/access-scope";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";
import { rememberLinqRoleSearchThread } from "@/db/services/pending-role-searches";
import { env } from "@/lib/env";
import { formatCandidateDelivery } from "@/lib/goforay/delivery";
import {
  goForayJobCardSchema,
  renderGoForayJobCard,
  type GoForayJobCard,
} from "@/lib/goforay/job-cards";
import { renderJobCardPng } from "@/lib/goforay/request-job-card-png";
import {
  isRichLinqService,
  linqServiceFromUnknown,
} from "@/lib/goforay/linq-service";
import {
  linqJobCardRepliesSchema,
  linqReplyToMessageId,
  rememberLinqJobCardReply,
  resolveLinqJobCardReply,
} from "@/lib/goforay/linq-replies";
import { createPostgresState } from "@/lib/linq-state";
import {
  normalizeLinqDocument,
  readLinqAttachment,
  retryLinqResumeSave,
} from "@/lib/linq-resume-import";
import { consumeWorkerCancellationTurn } from "../lib/worker-cancellation-delivery";
import { consumePendingApplicationSubmissionScreenshots } from "@/db/services/application-submission-screenshots";
import { normalizeTaskStatus } from "@/lib/task-completion";
import { linkCandidate, recordConversationMessage } from "@/lib/goforay/bridge";
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
const workerResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z
    .object({
      message: z.string().optional(),
      status: z.string(),
    })
    .loose(),
  toolName: z.literal("worker"),
});

/**
 * The worker pauses with this prefix once an application is filled and only the
 * submit control is left. The pause is a `failure` status, so screenshot
 * delivery cannot be armed off a successful result alone.
 */
const submissionApprovalPrefix = "Needs submission approval:";
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
type LinqReplyTarget = {
  message: string;
  role?: GoForayJobCard;
};

// Linq keeps a durable session for the whole iMessage thread. Supplying this on
// every turn lets an updated deployment supersede stale behavior in an older
// session instead of requiring the candidate to abandon their conversation.
const CURRENT_FORAY_POLICY = `
Current Foray policy: act as a capable general personal assistant with a
recruiting focus. Respond to the user's request now; never defer ordinary work
or promise roles, messages, or results tomorrow unless a real scheduled task is
configured. When a user asks for roles, immediately call find_goforay_roles.
That tool uses the candidate's stated details and workspace profile, and never
requires a JuiceBox candidate link. Applying is a worker assignment against
the apply URL; there is no GoForay application task. If Google is connected,
read existing resume/CV or job-search context in the same turn but never wait
for it before starting the role search or delivering its cards. If it is not
connected, a resume upload or LinkedIn URL is optional context, not a search
gate. Treat this policy as replacing any earlier conversation statement about
holding back, batching, or delaying roles. Speed never means repeating:
find_goforay_roles already excludes roles this candidate has seen, so a
request for more roles goes to a role tool, never to your memory of an earlier
batch and never to web_search. If a role tool reports nothing new, say so
instead of resending.
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
    async "action.result"(event, context) {
      if (context.thread) rememberLinqService(context.thread, context.state);
      const result = taskCancelResultSchema.safeParse(event.result);
      const sourceMessageId = context.thread?.toJSON().currentMessage?.id;
      const workerResult = workerResultSchema.safeParse(event.result);
      if (workerResult.success) {
        const submitted =
          normalizeTaskStatus(workerResult.data.output.status) === "success";
        const awaitingApproval = (workerResult.data.output.message ?? "")
          .trimStart()
          .startsWith(submissionApprovalPrefix);
        if (submitted || awaitingApproval) {
          context.state.pendingSubmissionScreenshot = {
            turnId: event.turnId,
          };
          // A review pause must not read as a finished application, so the two
          // outcomes get different reactions.
          await reactToCurrentMessage(
            context,
            sourceMessageId,
            submitted ? "✅" : "👀",
            submitted ? "application-submitted" : "application-review"
          );
        }
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
      if (context.thread) rememberLinqService(context.thread, context.state);
      if (event.finishReason === "tool-calls") {
        context.state.pendingToolCallMessage = event.message
          ? (event.message
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .find(Boolean) ?? null)
          : null;
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
            event.turnId,
            context.state
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
          event.turnId,
          context.state
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
export { channel };

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

  const replyTarget = await resolveLinqReplyTarget(message, thread);
  const inbound = await prepareInboundMessage(message, thread, replyTarget);

  try {
    await bot.getAdapter("linq").markRead(thread.id, message.id);
  } catch {
    // Read receipts are optional and must not interrupt the candidate turn.
  }

  if (isApplicationRequest(message.text)) {
    await reactToLinqMessage(thread, message.id, "👍");
  }

  await send(
    {
      context: inbound.context,
      // Persist attachments before this turn and place their extracted text in
      // workspace context. Passing the provider's raw PDF URL to the model
      // gateway makes every configured provider reject the request.
      message: message.text || "The candidate attached a file.",
    },
    { auth: inbound.auth, thread }
  );
}

async function prepareInboundMessage(
  message: Message,
  thread: Thread,
  replyTarget: LinqReplyTarget | undefined
) {
  const auth = defaultLinqAuth(message);
  const authorUserName: unknown = message.author.userName;
  const phoneNumber =
    typeof authorUserName === "string"
      ? normalizeAuthPhoneNumber(authorUserName)
      : undefined;
  const verifiedUser = phoneNumber
    ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
    : undefined;
  const legacyScope = accessScopeForUser(auth.principalId);
  // A Linq text is possession of the phone number. Do not split storage based
  // on whether the optional web account happened to be found this turn.
  const scope = phoneNumber ? accessScopeForPhone(phoneNumber) : legacyScope;
  if (phoneNumber) {
    await adoptLegacyWorkspace(scope, [
      legacyScope,
      ...(verifiedUser
        ? [accessScopeForUser(`better-auth:${verifiedUser.id}`)]
        : []),
    ]);
  }
  await rememberLinqRoleSearchThread(scope, thread.id, phoneNumber);
  if (phoneNumber) {
    try {
      await linkCandidate({
        scope,
        name: verifiedUser?.name ?? "",
        identities: [
          { kind: "phone", value: phoneNumber, verified: true },
          ...(verifiedUser?.emailVerified && verifiedUser.email
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
      ...(importedResumes.uploaded.length
        ? [
            `The candidate attached a document. It is stored in this workspace (${importedResumes.uploaded.join(", ")}). Use it for applications and do not ask them to upload it again or expose the file contents.`,
          ]
        : []),
      ...(importedResumes.downloadFailures.length
        ? [
            `An attachment could not be retrieved from the messaging provider: ${importedResumes.downloadFailures.join("; ")}. The file never reached this server, so ask the candidate to send it again, then continue helping with everything that does not need it.`,
          ]
        : []),
      ...(importedResumes.storageFailures.length
        ? [
            `An attachment reached this server but could not be saved, and an automatic retry failed the same way: ${importedResumes.storageFailures.join("; ")}. Resending the same file will not help, so do not ask for it again. Tell the candidate their file arrived but could not be saved and that this is being looked into, then continue helping with everything that does not need the file.`,
          ]
        : []),
      ...(importedResumes.skipped.length
        ? [
            `The candidate attached something this workspace does not store as a document: ${importedResumes.skipped.join(", ")}. Only PDF and DOCX files are kept. Say what arrived and ask for a PDF or DOCX if a resume was intended.`,
          ]
        : []),
      ...(replyTarget?.role
        ? [
            `The candidate replied directly to this role card: ${replyTarget.role.title} at ${replyTarget.role.company} (${replyTarget.role.location}). Its apply URL is ${replyTarget.role.url}. Treat the reply as an explicit selection of this role. In particular, "apply to this" means apply to this exact URL. Do not ask them to restate the company, title, number, or URL.`,
          ]
        : replyTarget
          ? [
              `The candidate replied directly to this earlier message: ${replyTarget.message}. Use that message as the referent for words such as "this one" or "that". Do not ask them to repeat it when it identifies their choice.`,
            ]
          : []),
    ],
    auth: {
      ...auth,
      attributes: {
        ...auth.attributes,
        workspaceId: scope.workspaceId,
      },
      // The phone is the candidate's durable identity, so iMessage must forward
      // the same principal id the web channel and the schedules do. Anything
      // else gives Vercel Connect a different subject over iMessage, and a
      // Google grant made on the web is invisible here: every Gmail call then
      // asks the candidate to authorize Google again.
      principalId: scope.userId,
    },
  };
}

async function resolveLinqReplyTarget(
  message: Message,
  thread: Thread
): Promise<LinqReplyTarget | undefined> {
  const replyToMessageId = linqReplyToMessageId(message.raw);
  if (!replyToMessageId) return undefined;
  const state = await thread.state;
  const cards = linqJobCardRepliesSchema.safeParse(
    state?.linqJobCardsByMessageId
  );
  const role = cards.success
    ? resolveLinqJobCardReply(message.raw, cards.data)
    : undefined;
  if (role) return { message: renderGoForayJobCard(role, 1, 1), role };

  let inspected = 0;
  for await (const priorMessage of thread.messages) {
    if (priorMessage.id === replyToMessageId && priorMessage.text.trim()) {
      return { message: priorMessage.text.trim().slice(0, 2_000) };
    }
    inspected += 1;
    if (inspected >= 40) break;
  }
  return undefined;
}

function isApplicationRequest(text: string) {
  return /\b(?:apply|application)\b/iu.test(text);
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

async function importLinqResumes(
  message: Message,
  scope: ReturnType<typeof accessScopeForUser>
) {
  const uploaded: string[] = [];
  const downloadFailures: string[] = [];
  const storageFailures: string[] = [];
  const skipped: string[] = [];
  for (const attachment of message.attachments) {
    const filename = attachment.name ?? filenameFromUrl(attachment.url ?? "");
    // Nothing below can drop an attachment silently: the model no longer sees
    // the raw attachment, so this loop is the only account of what arrived.
    if (attachment.type !== "file") {
      skipped.push(filename);
      console.warn("[linq-resume] attachment is not a file", {
        attachmentType: attachment.type,
        mimeType: attachment.mimeType ?? "",
        workspaceId: scope.workspaceId,
      });
      continue;
    }

    let phase = "download";
    try {
      const { bytes, resolvedMimeType } = await readLinqAttachment(attachment);
      // Linq reports an empty mime type as often as it omits it.
      const mimeType = attachment.mimeType || resolvedMimeType;
      const document = normalizeLinqDocument({ bytes, filename, mimeType });
      if (!document) {
        skipped.push(filename);
        console.warn("[linq-resume] attachment is not a supported document", {
          attachmentType: attachment.type,
          mimeType,
          suffix: filename.split(".").at(-1)?.toLowerCase() ?? "",
          workspaceId: scope.workspaceId,
        });
        continue;
      }

      phase = "storage";
      const result = await saveLinqResumeWithRetry(scope, {
        bytes,
        filename: document.filename,
        mimeType: document.mimeType,
      });
      uploaded.push(result.document.filename);
    } catch (error) {
      const message = linqImportErrorMessage(error);
      const failure = `${filename} (${message})`;
      if (phase === "download") downloadFailures.push(failure);
      else storageFailures.push(failure);
      console.error("[linq-resume] attachment import failed", {
        attachment: {
          attachmentType: attachment.type,
          hasFetchData: attachment.fetchData !== undefined,
          mimeType: attachment.mimeType ?? "",
          size: attachment.size,
          suffix: filename.split(".").at(-1)?.toLowerCase() ?? "",
        },
        error: message,
        phase,
        workspaceId: scope.workspaceId,
      });
    }
  }
  return { downloadFailures, skipped, storageFailures, uploaded };
}

async function saveLinqResumeWithRetry(
  scope: ReturnType<typeof accessScopeForUser>,
  input: {
    readonly bytes: Buffer;
    readonly filename: string;
    readonly mimeType: string;
  }
) {
  return retryLinqResumeSave(() =>
    saveCandidateDocument(scope, {
      ...input,
      kind: inferCandidateDocumentKind(input.filename),
      setDefault: true,
      source: "linq",
    })
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

function linqImportErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "import failed";
  return message.replace(/https?:\/\/\S+/gu, "<attachment-url>").slice(0, 300);
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

async function reactToLinqMessage(
  thread: Thread,
  messageId: string,
  emoji: string
) {
  try {
    await thread.adapter.addReaction(thread.id, messageId, emoji);
  } catch {
    // SMS/RCS and web paths do not guarantee reaction support.
  }
}

async function deliverSubmissionScreenshot(
  thread: {
    post: (message: {
      markdown: string;
      files?: { data: Buffer; filename: string; mimeType: string }[];
    }) => Promise<{ id?: unknown }>;
    toJSON: () => unknown;
  },
  scope: ReturnType<typeof scopeFromPrincipal>,
  turnId: string,
  state: Record<string, unknown>
) {
  if (!isRichLinqThread(thread, state)) return;
  try {
    const screenshots =
      await consumePendingApplicationSubmissionScreenshots(scope);
    // A review is scroll-stitched across several captures, so post each one in
    // page order rather than only the last. The batch can also carry an older
    // undelivered proof, so number the review pages among themselves.
    const reviewPages = screenshots.filter(
      (screenshot) => screenshot.kind === "review"
    ).length;
    let reviewPage = 0;
    for (const [position, screenshot] of screenshots.entries()) {
      const review = screenshot.kind === "review";
      if (review) reviewPage += 1;
      await thread.post({
        markdown: review
          ? `Before I submit — page ${String(reviewPage)} of ${String(reviewPages)}. Reply *yes* to submit, or tell me what to change.`
          : "",
        files: [
          {
            data: screenshot.png,
            filename: review
              ? `application-review-${String(reviewPage)}.png`
              : "application-submitted.png",
            mimeType: screenshot.mimeType,
          },
        ],
      });
      void recordConversationMessage({
        scope,
        conversationId: `linq:${scope.userId}`,
        channel: "linq",
        direction: "outbound",
        body: review
          ? "application review screenshot"
          : "application submitted screenshot",
        sourceMessageId: `linq:${turnId}:${screenshot.kind}-screenshot:${String(position)}`,
      }).catch(() => undefined);
    }
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
  turnId: string,
  state: Record<string, unknown>
) {
  const service = rememberLinqService(thread, state);
  const rich = isRichLinqService(service);
  // Image delivery is guarded by this protocol check and by the renderer, and
  // both used to fail silently. Name which one ran so a single iMessage turn
  // says whether text arrived because the thread read as SMS or because the
  // PNG never painted.
  console.info("[goforay] delivering Linq job cards", {
    cards: cards.length,
    rich,
    service: service || "unknown",
  });
  // Each render fetches an employer favicon with its own timeout, so painting
  // the batch up front keeps one webhook turn from serialising five of them.
  // Posting stays sequential: the cards are numbered, and each post writes the
  // reply mapping into `state`.
  const images = rich
    ? await Promise.all(
        cards.map((card, offset) =>
          renderJobCardPng(card, offset + 1, cards.length).catch(
            () => undefined
          )
        )
      )
    : [];
  for (const [offset, card] of cards.entries()) {
    const index = offset + 1;
    const text = renderGoForayJobCard(card, index, cards.length);
    let sentImage = false;
    const png = images[offset];
    if (png) {
      try {
        const sent = await thread.post({
          markdown: "",
          files: [
            {
              data: png.bytes,
              filename: png.filename,
              mimeType: "image/png",
            },
          ],
        });
        rememberSentLinqJobCard(state, sent, card);
        sentImage = true;
      } catch {
        // The text card remains useful if media upload is unavailable.
      }
    }
    if (!sentImage) {
      const sent = await thread.post({ markdown: text });
      rememberSentLinqJobCard(state, sent, card);
    }
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

function rememberSentLinqJobCard(
  state: Record<string, unknown>,
  sent: unknown,
  card: GoForayJobCard
) {
  const message = z.object({ id: z.string().min(1) }).safeParse(sent);
  if (!message.success) return;
  const stored = linqJobCardRepliesSchema.safeParse(
    state.linqJobCardsByMessageId
  );
  state.linqJobCardsByMessageId = rememberLinqJobCardReply(
    stored.success ? stored.data : {},
    message.data.id,
    card
  );
}

function rememberLinqService(
  thread: { toJSON: () => unknown },
  state: Record<string, unknown>
) {
  const fromThread = linqServiceFromUnknown(thread.toJSON());
  if (fromThread) state.lastLinqService = fromThread;
  return (
    fromThread ||
    (typeof state.lastLinqService === "string" ? state.lastLinqService : "")
  );
}

function isRichLinqThread(
  thread: { toJSON: () => unknown },
  state?: Record<string, unknown>
) {
  const service = state
    ? rememberLinqService(thread, state)
    : linqServiceFromUnknown(thread.toJSON());
  return isRichLinqService(service);
}
