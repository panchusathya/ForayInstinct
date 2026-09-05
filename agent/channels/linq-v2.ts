/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Eve's Linq adapter exposes the thread through a transitive Chat SDK type; TypeScript still checks this contextual handler. */
import { connectLinqCredentials } from "@vercel/connect/eve";
import { createLinqAdapter } from "@linqapp/chat-sdk-adapter";
import { defaultLinqAuth } from "eve/channels/linq";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import type { Message, ReactionEvent, Thread } from "chat";
import { z } from "zod";
import { auth } from "@/auth";
import { normalizeAuthPhoneNumber } from "@/auth/phone-number";
import { rememberContactPhone } from "@/lib/manager/server/contact-phone";
import {
  accessScopeForPhone,
  accessScopeForUser,
  scopeFromPrincipal,
} from "@/lib/access-scope";
import { adoptLegacyWorkspace } from "@/db/services/adopt-legacy-workspace";
import {
  findLinqThread,
  rememberLinqRoleSearchThread,
} from "@/db/services/pending-role-searches";
import { env } from "@/lib/env";
import { formatCandidateDelivery } from "@/lib/goforay/delivery";
import {
  goForayJobCardSchema,
  jobCardView,
  renderGoForayJobCard,
  type GoForayJobCard,
} from "@/lib/goforay/job-cards";
import { renderJobCardPng } from "@/lib/goforay/request-job-card-png";
import {
  isRichLinqService,
  linqServiceFromUnknown,
} from "@/lib/goforay/linq-service";
import { linqReplyToMessageId } from "@/lib/goforay/linq-replies";
import {
  linqJobCardForMessageId,
  readLinqJobCards,
  rememberLinqJobCard,
} from "@/lib/goforay/linq-job-card-state";
import { createPostgresState } from "@/lib/linq-state";
import {
  normalizeLinqDocument,
  readLinqAttachment,
  retryLinqResumeSave,
} from "@/lib/linq-resume-import";
import { consumeWorkerCancellationTurn } from "../lib/worker-cancellation-delivery";
import {
  claimPendingApplicationSubmissionScreenshots,
  listPendingApplicationSubmissionScreenshotScopes,
  releaseApplicationSubmissionScreenshots,
} from "@/db/services/application-submission-screenshots";
import {
  pauseKindFromOutput,
  normalizeTaskStatus,
} from "@/lib/task-completion";
import { linkCandidate, recordConversationMessage } from "@/lib/goforay/bridge";
import { withTimeout } from "@/lib/with-timeout";

/** How long any one optional inbound step may take before it is abandoned. */
const INBOUND_STEP_TIMEOUT_MS = 5_000;
import { saveCandidateDocument } from "@/db/services/candidate-documents";
import { inferCandidateDocumentKind } from "@/lib/candidate-documents";
import { Client } from "eve/client";
import { getVercelOidcToken } from "@vercel/oidc";
import { findRestartableApplicationExecutions } from "@/db/services/application-executions";
import {
  rememberLinqSessionActivity,
  rollOverStaleLinqSession,
} from "../lib/linq-session-rollover";
import {
  renderInputRequestText,
  resolveSessionLimitPrompt,
  sessionLimitRequests,
  sessionStoppedMessage,
} from "../lib/linq-input-requests";

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
      applyUrl: z.string().optional(),
      message: z.string().optional(),
      pause: z.string().optional(),
      status: z.string().optional(),
    })
    .loose(),
  toolName: z.enum(["continue_application", "start_application", "worker"]),
});

const jobCardResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: z.object({ cards: z.array(goForayJobCardSchema) }),
  toolName: z.enum(["find_goforay_roles", "find_next_goforay_roles"]),
});
/** Connections this thread has already been asked to connect, by name. */
const linqAuthorizationNoticesSchema = z.record(z.string(), z.boolean());
const pendingJobCardsSchema = z.object({
  cards: z.array(goForayJobCardSchema),
  turnId: z.string(),
});
const pendingSubmissionScreenshotSchema = z.object({
  turnId: z.string(),
});
/** The turn whose approval prose the delivered form images already replaced. */
const suppressedApprovalTurnSchema = z.object({
  turnId: z.string(),
});
/**
 * `reviewPages` is how many review images actually reached the thread. The
 * coordinator's approval prose is suppressed against it: the candidate sees the
 * form itself, so a written recap of it is noise, but silence is only safe once
 * the images are known to have arrived.
 */
interface SubmissionScreenshotDelivery {
  reviewPages: number;
  status: "blocked" | "delivered" | "nothing-pending";
}
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
requires a JuiceBox candidate link. Applying is start_application against
the apply URL; there is no GoForay application task. Runner pauses return a
structured { pause } of approval, email_otp, user_input, vault_setup, or
posting_unavailable — do not parse Needs prefixes. If Google is connected,
read existing resume/CV or job-search context in the same turn but never wait
for it before starting the role search or delivering its cards. If it is not
connected, a resume upload or LinkedIn URL is optional context, not a search
gate. Treat this policy as replacing any earlier conversation statement about
holding back, batching, or delaying roles. Speed never means repeating:
find_goforay_roles already excludes roles this candidate has seen, so a
request for more roles goes to a role tool, never to your memory of an earlier
batch and never to web_search. If a role tool reports nothing new, say so
instead of resending. A thumbs-up tapback on a role card is that candidate
applying to that role: the channel resolves the card and attaches its apply
URL, so never answer a tapback by asking which role they meant, and never tell
a candidate to reply with a number when a tapback will do.
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
    async "turn.started"(event, context, session) {
      // Recover a capture left behind by an interrupted coordinator turn before
      // asking the model to do anything. This means an upstream model failure
      // cannot prevent the candidate from seeing the already-captured form.
      const pendingScreenshot = pendingSubmissionScreenshotSchema.safeParse(
        context.state.pendingSubmissionScreenshot
      );
      if (!pendingScreenshot.success) return;
      const caller =
        session.session.auth?.current ?? session.session.auth?.initiator;
      if (!caller) return;
      const scope = scopeFromPrincipal(caller);
      const thread = await submissionDeliveryThread(context.thread, scope);
      if (!thread) return;
      const delivery = await deliverSubmissionScreenshot(
        thread,
        scope,
        event.turnId,
        context.state
      );
      if (delivery.status === "delivered") {
        context.state.pendingSubmissionScreenshot = undefined;
      }
    },
    async "input.requested"(event, context, session) {
      // Eve's default renders each request as a card with buttons, which Linq
      // flattens to text whose buttons never fire. Answer the framework's own
      // budget guardrail here so the candidate never sees it, and render the
      // prompts that really need them as numbered plain text: a reply that
      // matches an option's number or label resolves the request.
      const limits = sessionLimitRequests(event.requests);
      if (limits.length > 0) {
        try {
          const decision = await resolveSessionLimitPrompt({
            requests: limits,
            sessionId: session.session.id,
          });
          if (decision === "stopped" && context.thread) {
            await context.thread.post({ markdown: sessionStoppedMessage });
          }
        } catch (error) {
          console.error("[linq-session] session-limit prompt unanswered", {
            message: error instanceof Error ? error.message : String(error),
            session_id: session.session.id,
          });
        }
      }
      const remaining = event.requests.filter(
        (request) => request.kind !== "session-limit"
      );
      if (remaining.length === 0 || !context.thread) return;
      await context.thread.post({
        markdown: remaining.map(renderInputRequestText).join("\n\n"),
      });
    },
    async "authorization.required"(event, context) {
      // Eve's default handler posts Vercel Connect's device-pairing code and
      // its URL. iMessage collapses that into one run-together line the
      // candidate cannot act on, and a code is never the answer to a task in
      // flight: point them at the workspace page, which holds the connect
      // button for the same phone-derived Connect subject this channel uses.
      if (!context.thread || event.candidateId !== undefined) return;
      const notified = linqAuthorizationNoticesSchema.safeParse(
        context.state.authorizationNoticesSent
      );
      const sent = notified.success ? notified.data : {};
      if (sent[event.name]) return;
      const displayName = event.authorization?.displayName ?? event.name;
      const delivery = formatCandidateDelivery(
        [
          `Foray needs access to your ${displayName} account to finish that.`,
          "Connect it on your workspace page, then send me a message and I'll pick up where I left off.",
          new URL("/", env.BETTER_AUTH_URL).toString(),
        ].join("\n\n")
      );
      for (const body of delivery.bubbles) {
        await context.thread.post({ markdown: body });
      }
      // Deliberately not `pendingAuthMessageIds`: that key makes Eve's default
      // `authorization.completed` handler edit this notice into an
      // authorization-timed-out line when the candidate connects on the web
      // instead of completing the device flow.
      context.state.authorizationNoticesSent = { ...sent, [event.name]: true };
    },
    async "action.result"(event, context, session) {
      if (context.thread) rememberLinqService(context.thread, context.state);
      const result = taskCancelResultSchema.safeParse(event.result);
      const sourceMessageId = context.thread?.toJSON().currentMessage?.id;
      const workerResult = workerResultSchema.safeParse(event.result);
      if (workerResult.success) {
        const output = workerResult.data.output;
        const submitted =
          workerResult.data.toolName === "worker" &&
          normalizeTaskStatus(output.status ?? "") === "success";
        // Classify by the structured pause enum. Leftover worker messages
        // still generate Needs prefixes from that enum, so prefix parsing is
        // only a fallback via pauseKindFromOutput.
        const pause = pauseKindFromOutput(output);
        const awaitingApproval = pause === "approval";
        const shouldDeliver =
          workerResult.data.toolName === "worker" || awaitingApproval;
        const caller =
          session.session.auth?.current ?? session.session.auth?.initiator;
        const scope = caller ? scopeFromPrincipal(caller) : undefined;
        const thread = scope
          ? await submissionDeliveryThread(context.thread, scope)
          : undefined;
        const delivery: SubmissionScreenshotDelivery =
          scope && thread && shouldDeliver
            ? await deliverSubmissionScreenshot(
                thread,
                scope,
                event.turnId,
                context.state,
                output.applyUrl
              )
            : { reviewPages: 0, status: "blocked" };
        // Only retain a retry marker for outcomes known to have an expected
        // image. Ordinary worker tasks can legitimately have nothing queued.
        if (
          delivery.status !== "delivered" &&
          (submitted || awaitingApproval)
        ) {
          context.state.pendingSubmissionScreenshot = {
            turnId: event.turnId,
          };
        }
        // The candidate is looking at the form itself, so a written recap of it
        // is the spam this gate is meant to avoid. Suppress the coordinator's
        // prose for this turn only when the images actually arrived; a capture
        // that never reached them still needs the words.
        if (awaitingApproval && delivery.reviewPages > 0) {
          context.state.suppressedApprovalTurn = { turnId: event.turnId };
        }
        if (submitted || awaitingApproval) {
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
      if (pendingScreenshot.success) {
        const caller =
          session.session.auth?.current ?? session.session.auth?.initiator;
        const delivery =
          caller &&
          (await deliverSubmissionScreenshot(
            context.thread,
            scopeFromPrincipal(caller),
            event.turnId,
            context.state
          ));
        if (delivery?.status === "delivered") {
          context.state.pendingSubmissionScreenshot = undefined;
        }
        // A stranded review flushed here is the "show me the screenshots" turn,
        // whose prose is the narration about screenshots the candidate never
        // asked for. The images answered them.
        if (delivery && delivery.reviewPages > 0) {
          context.state.suppressedApprovalTurn = { turnId: event.turnId };
        }
      }

      if (!event.message) return;

      const suppressedApproval = suppressedApprovalTurnSchema.safeParse(
        context.state.suppressedApprovalTurn
      );
      if (suppressedApproval.success) {
        // Clear it either way: a marker left by an earlier turn must never
        // silence a later, unrelated message.
        context.state.suppressedApprovalTurn = undefined;
        if (suppressedApproval.data.turnId === event.turnId) return;
      }

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
// A thumbs-up on a role card is the candidate applying to that role. Reactions
// are not eve session events, so this is the only place they arrive. The string
// filter matches both the emoji name and Linq's own `like`.
bot.onReaction(["thumbs_up"], dispatchLinqJobCardTapback);

export default channel;
export { channel };

/** Claims survive as long as the card mapping they resolve against. */
const APPLY_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function applyClaimKey(threadId: string, messageId: string) {
  return `goforay-card-apply:${threadId}:${messageId}`;
}

/**
 * One application per card, whatever the provider does.
 *
 * `reaction.added` can be redelivered, a candidate can remove and re-add a
 * tapback, and two lambdas can race the same webhook. `setIfNotExists` is a
 * single INSERT ... ON CONFLICT, so the winner is decided in Postgres rather
 * than in whichever instance happens to be first.
 */
async function claimLinqCardApply(threadId: string, messageId: string) {
  try {
    const won: unknown = await bot
      .getState()
      .setIfNotExists(
        applyClaimKey(threadId, messageId),
        { at: new Date().toISOString() },
        APPLY_CLAIM_TTL_MS
      );
    return won === true;
  } catch (error) {
    // Fail closed: a duplicate application is worse than a missed tapback.
    console.error("[goforay] tapback claim store unavailable", {
      message: error instanceof Error ? error.message : String(error),
      threadId,
    });
    return false;
  }
}

async function releaseLinqCardApply(threadId: string, messageId: string) {
  try {
    await bot.getState().delete(applyClaimKey(threadId, messageId));
  } catch {
    // The claim expires on its own; a stuck claim only costs one retry.
  }
}

/**
 * The workspace behind a reaction. `ReactionEvent.user` is the same `Author`
 * shape a message carries, so the same auth derivation applies — and without
 * `attributes.workspaceId` the worker would run with no profile and no resume.
 */
function linqPrincipalFromAuthor(input: { author: Message["author"] }) {
  // `defaultLinqAuth` reads only `message.author`, and a reaction carries the
  // same `Author`, so this is the whole input it needs — which is what lets a
  // text and a tapback share one derivation.
  const auth = defaultLinqAuth(input);
  const authorUserName: unknown = input.author.userName;
  const phoneNumber =
    typeof authorUserName === "string"
      ? normalizeAuthPhoneNumber(authorUserName)
      : undefined;
  const legacyScope = accessScopeForUser(auth.principalId);
  // A Linq text is possession of the phone number. Do not split storage based
  // on whether the optional web account happened to be found this turn.
  const scope = phoneNumber ? accessScopeForPhone(phoneNumber) : legacyScope;
  return {
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
      // asks the candidate to authorize Google again. This lives here, shared,
      // because it was fixed for a text and missed for a tapback.
      principalId: scope.userId,
    },
    legacyScope,
    phoneNumber,
    scope,
  };
}

async function dispatchLinqJobCardTapback(event: ReactionEvent) {
  // A removed tapback is not a decision, and our own outbound reactions come
  // back through here too. `isBot` is `boolean | "unknown"` and Linq derives it
  // from `is_from_me`, so compare strictly or real candidates get dropped.
  if (!event.added) return;
  if (event.user.isMe || event.user.isBot === true) return;

  const thread = event.thread;
  const card = linqJobCardForMessageId(
    await readLinqJobCards(thread),
    event.messageId
  );
  if (!card) {
    // Silence. Most tapbacks land on ordinary messages, and an expired card
    // mapping is indistinguishable from a like on the candidate's own text.
    console.warn("[goforay] tapback with no card mapping", {
      messageId: event.messageId,
      threadId: event.threadId,
    });
    return;
  }

  let principal: ReturnType<typeof linqPrincipalFromAuthor>;
  try {
    principal = linqPrincipalFromAuthor({ author: event.user });
  } catch (error) {
    console.error("[goforay] tapback from an unusable handle", {
      message: error instanceof Error ? error.message : String(error),
      threadId: event.threadId,
    });
    return;
  }

  if (!(await claimLinqCardApply(event.threadId, event.messageId))) return;

  const view = jobCardView(card, 1, 1);
  // Name the role rather than tapping back: the candidate's own thumbs-up is
  // already on that message, so an echo would not tell them we resolved the
  // right card. If the mapping is wrong they see it in one line.
  await thread.post({
    markdown: `on it, applying to ${view.title.toLowerCase()} at ${view.company.toLowerCase()}`,
  });
  void recordConversationMessage({
    scope: principal.scope,
    conversationId: `linq:${principal.scope.userId}`,
    channel: "linq",
    direction: "inbound",
    body: `thumbs-up apply: ${view.title} at ${view.company}`,
    sourceMessageId: `linq:reaction:${event.messageId}`,
  }).catch(() => undefined);

  try {
    // Bounded for the same reason as the message path: this runs inside the
    // reaction webhook, and an idle reset that never settles would spend the
    // whole function budget before the application is ever started.
    await withTimeout(
      () => rollOverStaleLinqSession(thread),
      INBOUND_STEP_TIMEOUT_MS,
      "kept" as const
    );
    const session = await send(
      {
        context: [
          CURRENT_FORAY_POLICY,
          `The candidate reacted with a thumbs-up to this role card: ${card.title} at ${card.company} (${card.location}). Its apply URL is ${card.url}. On iMessage a thumbs-up on a role card is an explicit instruction to apply to that exact role, the same as a threaded reply saying "apply to this". Start the worker assignment against this exact URL now. Do not call a role search tool, do not ask which role they meant, and do not ask them to restate the company, title, number, or URL. The channel has already told the candidate you are applying to this role, so do not repeat that acknowledgement.`,
        ],
        message: "apply to this",
      },
      {
        auth: principal.auth,
        thread,
        // The channel default steers, which cancels the running turn: two quick
        // tapbacks would cancel the first application. Queue them instead.
        turnPolicy: "queue",
      }
    );
    await rememberLinqSessionActivity(thread, session);
  } catch (error) {
    await releaseLinqCardApply(event.threadId, event.messageId);
    console.error("[goforay] tapback apply failed to start", {
      message: error instanceof Error ? error.message : String(error),
      threadId: event.threadId,
    });
  }
}

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

/**
 * Times one inbound step and records it.
 *
 * The webhook runs the candidate's whole turn, so when it died at the
 * five-minute function limit the log simply stopped, naming nothing. Each
 * step now reports its own duration: the last line before a timeout is the
 * step that hung. Names and milliseconds only, never message text.
 */
async function inboundStep<T>(
  name: string,
  messageId: string,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    console.info("[linq-inbound] step", {
      duration_ms: Date.now() - startedAt,
      message_id: messageId,
      step: name,
    });
  }
}

async function dispatchLinqMessage(thread: Thread, message: Message) {
  if (message.author.isBot) return;

  const replyTarget = await inboundStep("reply_target", message.id, () =>
    resolveLinqReplyTarget(message, thread)
  );
  const inbound = await inboundStep("prepare", message.id, () =>
    prepareInboundMessage(message, thread, replyTarget)
  );

  // A worker can capture the review and then fail before its parent emits a
  // result. Channel lifecycle recovery cannot post in that case when a cold
  // webhook has not yet restored the serialized thread. The inbound webhook
  // always has the real thread, so flush the newest pending review here before
  // the next model call has a chance to fail.
  await inboundStep("review_recovery", message.id, () =>
    deliverSubmissionScreenshot(
      thread,
      inbound.scope,
      `linq:inbound:${message.id}:review-recovery`,
      {}
    )
  );

  const restartQuery = applicationRestartQuery(message.text);
  if (restartQuery) {
    const restart = await inboundStep("restart", message.id, () =>
      restartTrackedApplication(thread, inbound, restartQuery)
    );
    if (restart) return;
  }

  // Read receipts, tapbacks, and the idle reset are courtesies. Bounded so a
  // provider that stops answering cannot spend the turn's whole budget on one.
  await inboundStep("mark_read", message.id, () =>
    withTimeout(
      async () => {
        await bot.getAdapter("linq").markRead(thread.id, message.id);
      },
      INBOUND_STEP_TIMEOUT_MS,
      undefined
    )
  );

  if (isApplicationRequest(message.text)) {
    await inboundStep("reaction", message.id, () =>
      withTimeout(
        () => reactToLinqMessage(thread, message.id, "👍"),
        INBOUND_STEP_TIMEOUT_MS,
        undefined
      )
    );
  }

  // A long-quiet thread gets a fresh session: less history to re-read on
  // every call, and the current deployment's instructions.
  await inboundStep("rollover", message.id, () =>
    withTimeout(
      () => rollOverStaleLinqSession(thread),
      INBOUND_STEP_TIMEOUT_MS,
      "kept" as const
    )
  );
  const session = await inboundStep("send", message.id, () =>
    send(
      {
        context: inbound.context,
        // Persist attachments before this turn and place their extracted text
        // in workspace context. Passing the provider's raw PDF URL to the
        // model gateway makes every configured provider reject the request.
        message: message.text || "The candidate attached a file.",
      },
      { auth: inbound.auth, thread }
    )
  );
  await rememberLinqSessionActivity(thread, session);
}

/** Explicit restart is intentionally narrow: normal conversational retries keep context. */
function applicationRestartQuery(text: string) {
  const match =
    /^\s*restart\s+(?:the\s+)?(.+?)(?:\s+application)?\s*[.!?]?\s*$/iu.exec(
      text
    );
  return match?.[1]?.trim();
}

async function restartTrackedApplication(
  thread: Thread,
  inbound: Awaited<ReturnType<typeof prepareInboundMessage>>,
  query: string
) {
  const matches = await findRestartableApplicationExecutions(
    inbound.scope,
    query
  );
  if (matches.length !== 1 || !matches[0]?.applyUrl) {
    await thread.post({
      markdown:
        matches.length > 1
          ? "I found more than one matching application. Reply with the role title and its apply URL so I restart the right one."
          : "I do not have a tracked application matching that name. Reply with the role title and apply URL and I’ll start a fresh run.",
    });
    return true;
  }
  const execution = matches[0];
  try {
    const client = new Client({
      auth: {
        vercelOidc: { token: () => getVercelOidcToken() },
      },
      host: env.BETTER_AUTH_URL,
      redirect: "error",
    });
    await client.sessions.attach(execution.rootSessionId).reset({
      reason: "Explicit application restart requested by the candidate.",
    });
    const session = await send(
      {
        context: [
          CURRENT_FORAY_POLICY,
          `Start a new application worker now. The previous run was terminally retired and must not be resumed. Application trace identity: role=${execution.role}; company=${execution.company}; apply_url=${execution.applyUrl}`,
        ],
        message: `Apply to ${execution.role || "this role"} at ${execution.company || "this company"}.`,
      },
      { auth: inbound.auth, thread }
    );
    await rememberLinqSessionActivity(thread, session);
    return true;
  } catch (error) {
    console.error("[application-execution] restart failed", {
      error: error instanceof Error ? error.message : "unknown",
      root_session_id: execution.rootSessionId,
    });
    await thread.post({
      markdown:
        "I found that application, but could not safely reset its old run. Reply with the apply URL and I’ll start a new run.",
    });
    return true;
  }
}

async function prepareInboundMessage(
  message: Message,
  thread: Thread,
  replyTarget: LinqReplyTarget | undefined
) {
  const { auth, legacyScope, phoneNumber, scope } =
    linqPrincipalFromAuthor(message);
  const verifiedUser = phoneNumber
    ? await findVerifiedAuthUserIdByPhoneNumber(phoneNumber)
    : undefined;
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
    // The number a candidate texts from is their number, and the one a form
    // asks for. Kept off the critical path like the CRM link below.
    void rememberContactPhone(scope, phoneNumber).catch(() => undefined);
    // Refreshing the CRM pointer is not on the candidate's critical path:
    // nothing below reads the result, and awaited here a slow JuiceBox held
    // the inbound webhook until the function timed out and the message was
    // lost. Started and not awaited, like the conversation mirror below.
    void linkCandidate({
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
    }).catch((error: unknown) => {
      // A missing or ambiguous CRM candidate must not block a normal text, but
      // it must not be invisible either: swallowed silently, a permanently
      // broken link looks identical to a candidate who simply never linked.
      console.warn("[goforay] candidate link unavailable", {
        message: error instanceof Error ? error.message : String(error),
        workspaceId: scope.workspaceId,
      });
    });
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
    // Already carries the phone-derived principal id and workspace: see
    // linqPrincipalFromAuthor, which a tapback shares.
    auth,
    scope,
  };
}

async function resolveLinqReplyTarget(
  message: Message,
  thread: Thread
): Promise<LinqReplyTarget | undefined> {
  const replyToMessageId = linqReplyToMessageId(message.raw);
  if (!replyToMessageId) return undefined;
  const role = linqJobCardForMessageId(
    await readLinqJobCards(thread),
    replyToMessageId
  );
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
  state: Record<string, unknown>,
  applyUrl?: string
): Promise<SubmissionScreenshotDelivery> {
  // Linq does not always include a transport label in the completion turn.
  // Try the attachment unless the transport is explicitly SMS: an unknown
  // thread can still be iMessage, whereas returning would leave a successfully
  // captured review stranded forever.
  const service = rememberLinqService(thread, state);
  if (service === "SMS") {
    console.warn("[submission-screenshot] delivery blocked by transport", {
      service,
      workspaceId: scope.workspaceId,
    });
    return { reviewPages: 0, status: "blocked" };
  }
  // Delivery used to fail silently, exactly as job cards did. A candidate asked
  // to approve a form they cannot see is the worst failure this channel has, so
  // it must never have to be inferred from an absence of logs. `warn`, not
  // `info`: the log search does not index info lines.
  const screenshots = await (
    applyUrl
      ? claimPendingApplicationSubmissionScreenshots(scope, { applyUrl })
      : claimPendingApplicationSubmissionScreenshots(scope)
  ).catch((error: unknown) => {
    console.error("[submission-screenshot] could not claim a batch", {
      message: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return undefined;
  });
  if (screenshots === undefined) return { reviewPages: 0, status: "blocked" };
  if (screenshots.length === 0) {
    console.warn("[submission-screenshot] nothing pending", {
      service: service || "unknown",
      workspaceId: scope.workspaceId,
    });
    return { reviewPages: 0, status: "nothing-pending" };
  }
  console.warn("[submission-screenshot] delivering", {
    count: screenshots.length,
    role: roleLabel(screenshots[0]?.role),
    sessionId: screenshots[0]?.sessionId,
  });

  // A review is scroll-stitched across several captures, so post each one in
  // page order rather than only the last. The batch is one session's, so the
  // review pages number among themselves and the caption can name the role.
  const reviewPages = screenshots.filter(
    (screenshot) => screenshot.kind === "review"
  ).length;
  const undelivered: number[] = [];
  let reviewPage = 0;
  for (const [position, screenshot] of screenshots.entries()) {
    const review = screenshot.kind === "review";
    if (review) reviewPage += 1;
    try {
      await thread.post({
        markdown: review
          ? reviewCaption(screenshot.role, reviewPage, reviewPages)
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
    } catch (error) {
      // Claiming stamps `deliveredAt` up front so two turns cannot post the
      // same image. That stamp has to come back off when the post fails, or the
      // candidate is asked to approve a form that was never shown to them.
      undelivered.push(screenshot.id);
      console.error("[submission-screenshot] post failed", {
        kind: screenshot.kind,
        message: error instanceof Error ? error.message : String(error),
        role: roleLabel(screenshot.role),
        workspaceId: scope.workspaceId,
      });
      continue;
    }
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

  if (undelivered.length === 0) return { reviewPages, status: "delivered" };
  await releaseApplicationSubmissionScreenshots(scope, undelivered).catch(
    (error: unknown) => {
      console.error("[submission-screenshot] could not release a batch", {
        count: undelivered.length,
        message: error instanceof Error ? error.message : String(error),
        workspaceId: scope.workspaceId,
      });
    }
  );
  // The candidate is being asked to approve something they cannot fully see.
  // Say so instead of letting the coordinator's "reply yes" stand on its own —
  // and say it for a partial review too, which is the worse case: approving a
  // form having been shown only the half of it that uploaded.
  const lostReviewPages = screenshots.filter(
    (screenshot) =>
      screenshot.kind === "review" && undelivered.includes(screenshot.id)
  ).length;
  if (lostReviewPages > 0) {
    await thread
      .post({
        markdown: reviewFallbackMessage(
          screenshots[0]?.role,
          lostReviewPages < reviewPages
        ),
      })
      .catch(() => undefined);
  }
  // A partial review is not a delivered one: the coordinator's message has to
  // stand rather than being suppressed behind half a form.
  return { reviewPages: reviewPages - lostReviewPages, status: "blocked" };
}

/**
 * A background subagent result can outlive the webhook's reconstructed thread
 * context. Rebuild the latest known Linq thread instead of leaving a completed
 * review queued until the candidate happens to message again.
 */
async function submissionDeliveryThread(
  activeThread:
    | {
        post: (message: {
          markdown: string;
          files?: { data: Buffer; filename: string; mimeType: string }[];
        }) => Promise<{ id?: unknown }>;
        toJSON: () => unknown;
      }
    | undefined,
  scope: ReturnType<typeof scopeFromPrincipal>
) {
  if (activeThread) return activeThread;
  const threadId = await findLinqThread(scope);
  return threadId ? bot.thread(threadId) : undefined;
}

/** Flushes the durable screenshot outbox without starting an agent turn. */
export async function flushPendingLinqSubmissionScreenshots() {
  const scopes = await listPendingApplicationSubmissionScreenshotScopes();
  await Promise.all(
    scopes.map(async (scope) => {
      const threadId = await findLinqThread(scope);
      if (!threadId) return;
      await deliverSubmissionScreenshot(
        bot.thread(threadId),
        scope,
        `linq:screenshot-sweep:${scope.workspaceId}:${Date.now()}`,
        {}
      );
    })
  );
}

/** Rows written before migration 0017 carry an empty role, not a missing one. */
function roleLabel(role: string | undefined) {
  return role?.trim() ? role : "unknown";
}

/**
 * The images are the whole message: the coordinator's prose is suppressed when
 * they go out, so the captions carry the naming, the ordering, and the ask by
 * themselves. Lowercase and em-dash-free to match the rest of the thread.
 */
function reviewCaption(role: string, page: number, pages: number) {
  const name = role.trim();
  const subject = name
    ? `your filled application for ${name.toLowerCase()}`
    : "your filled application";
  const ask = "reply *yes* to submit, or tell me what to change.";
  if (pages <= 1) return `here's ${subject}. ${ask}`;
  const counter = `page ${String(page)} of ${String(pages)}`;
  if (page === 1) return `here's ${subject}, ${counter}.`;
  return page === pages ? `${counter}. ${ask}` : `${counter}.`;
}

/**
 * `partial` is the dangerous case: some pages arrived, so the candidate has a
 * form in front of them and no reason to think they are missing any of it.
 */
function reviewFallbackMessage(role: string | undefined, partial: boolean) {
  const name = role?.trim();
  const subject = name
    ? `the filled form for ${name.toLowerCase()}`
    : "the filled form";
  return [
    partial
      ? `heads up, i could only send you part of ${subject}.`
      : `i could not send you ${subject}.`,
    "tell me to walk you through it and i will read the answers back before anything is submitted.",
  ].join("\n\n");
}

async function deliverJobCards(
  thread: {
    post: (message: {
      markdown: string;
      files?: { data: Buffer; filename: string; mimeType: string }[];
    }) => Promise<unknown>;
    setState: (patch: Record<string, unknown>) => Promise<unknown>;
    readonly state: Promise<Record<string, unknown> | null | undefined>;
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
  // `warn`, not `info`: the log search does not index info lines, and a
  // diagnostic nobody can find is not one.
  console.warn("[goforay] delivering Linq job cards", {
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
  // Read the mapping once, then extend it per post. A thumbs-up or a threaded
  // reply resolves against this, so it has to live where the webhook can read
  // it: Chat SDK thread state, not eve channel state.
  let delivered = await readLinqJobCards(thread);
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
        delivered = await rememberDeliveredCard(thread, delivered, sent, card);
        sentImage = true;
      } catch {
        // The text card remains useful if media upload is unavailable.
      }
    }
    if (!sentImage) {
      const sent = await thread.post({ markdown: text });
      delivered = await rememberDeliveredCard(thread, delivered, sent, card);
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

async function rememberDeliveredCard(
  thread: Parameters<typeof rememberLinqJobCard>[0],
  previous: Record<string, GoForayJobCard>,
  sent: unknown,
  card: GoForayJobCard
) {
  const message = z.object({ id: z.string().min(1) }).safeParse(sent);
  if (!message.success) return previous;
  return await rememberLinqJobCard(thread, previous, message.data.id, card);
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
