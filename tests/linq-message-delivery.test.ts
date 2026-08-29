/* oxlint-disable typescript/no-unsafe-type-assertion -- Eve's Linq adapter exposes the handler context through a transitive Chat SDK `any`; the fixture supplies only the fields exercised here. */
import { describe, expect, it, vi } from "vitest";
import workerCancellationHook from "../agent/hooks/worker-cancellation-delivery";

const cancellationStore = vi.hoisted(() => new Map<string, string>());

interface CompletedEvent {
  finishReason?: string | null;
  message?: string | null;
  sequence: number;
  stepIndex: number;
  turnId: string;
}

interface HandlerContext {
  bot: {
    getAdapter: () => {
      addReaction: (
        threadId: string,
        messageId: string,
        emoji: string
      ) => Promise<void>;
    };
  };
  state: Record<string, unknown>;
  thread: {
    id: string;
    post: (message: { markdown: string }) => Promise<void>;
    toJSON: () => { currentMessage?: { id?: string } };
  };
}

interface SessionContext {
  session: {
    auth?: { current?: unknown; initiator?: unknown };
    id: string;
  };
}

type MessageCompletedHandler = (
  event: CompletedEvent,
  context: HandlerContext,
  session: SessionContext
) => Promise<unknown>;

type ActionResultHandler = (
  event: {
    result: unknown;
    sequence: number;
    status: string;
    stepIndex: number;
    turnId: string;
  },
  context: HandlerContext,
  session?: SessionContext
) => Promise<unknown>;

const chatSdkChannelCapture = vi.hoisted(() => ({
  events: undefined as
    | {
        "action.result": ActionResultHandler;
        "message.completed": MessageCompletedHandler;
      }
    | undefined,
}));

vi.mock("../agent/lib/worker-cancellation-delivery", () => ({
  async recordWorkerCancellationTurn(
    sessionId: string,
    turnId: string,
    message: string
  ) {
    const taskId = /^Background task (\S+) \(worker\) is cancelled\.$/u.exec(
      message
    )?.[1];
    if (taskId) cancellationStore.set(`${sessionId}:${turnId}`, taskId);
  },
  async consumeWorkerCancellationTurn(sessionId: string, turnId: string) {
    const key = `${sessionId}:${turnId}`;
    const taskId = cancellationStore.get(key);
    cancellationStore.delete(key);
    return taskId;
  },
  async clearWorkerCancellationTurn(sessionId: string, turnId: string) {
    cancellationStore.delete(`${sessionId}:${turnId}`);
  },
}));

vi.mock("eve/channels/chat-sdk", () => ({
  chatSdkChannel(config: { events: typeof chatSdkChannelCapture.events }) {
    chatSdkChannelCapture.events = config.events;
    return {
      bot: {
        getAdapter: () => ({
          addReaction: async () => undefined,
          markRead: async () => undefined,
        }),
        onDirectMessage() {
          return undefined;
        },
        onNewMessage() {
          return undefined;
        },
      },
      channel: {},
      send: async () => undefined,
    };
  },
}));

vi.mock("@linqapp/chat-sdk-adapter", () => ({
  createLinqAdapter: () => ({}),
}));

vi.mock("@/lib/linq-state", () => ({
  createPostgresState: () => ({}),
}));

await import("../agent/channels/linq-v2");

const channelEvents = chatSdkChannelCapture.events;
if (!channelEvents) {
  throw new Error("Linq event handlers are not configured.");
}
const trackWorkerCancellation = channelEvents["action.result"];
const deliverCompletedMessage = channelEvents["message.completed"];

describe("Linq message delivery", () => {
  it("posts final responses as native iMessage Markdown", async () => {
    const message = [
      "Still blocked. No order was submitted.",
      "The order remains unchanged:",
      "Spider-Man: Brand New Day",
      "$15.00 total",
    ].join("\n");
    const { context, post } = handlerContext();

    await deliverCompletedMessage(
      completedEvent({ message }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ markdown: message });
  });

  it("suppresses intermediate tool-call messages", async () => {
    const { addReaction, context, post, state } = handlerContext();

    await deliverCompletedMessage(
      completedEvent({
        finishReason: "tool-calls",
        message: "Checking the checkout\nwith the browser",
      }),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
    expect(addReaction).toHaveBeenCalledExactlyOnceWith(
      "linq:dm:chat-1",
      "message-1",
      "thumbs_up"
    );
    expect(state.pendingToolCallMessage).toBe("Checking the checkout");
  });

  it("does not post an empty final response", async () => {
    const { context, post } = handlerContext();

    await deliverCompletedMessage(
      completedEvent({ message: null }),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("suppresses the redundant turn after task cancellation", async () => {
    const { context, post } = handlerContext();

    await trackWorkerCancellation(
      workerCancellationResult(),
      context,
      sessionContext()
    );
    await recordCancellationThroughHook(
      "session-1",
      "turn-2",
      "Background task task-worker (worker) is cancelled."
    );
    await deliverCompletedMessage(
      completedEvent({ message: "What should I check instead?" }),
      context,
      sessionContext()
    );
    await deliverCompletedMessage(
      completedEvent({
        message: "The previous task was cancelled.",
        turnId: "turn-2",
      }),
      context,
      sessionContext()
    );
    await deliverCompletedMessage(
      completedEvent({ message: "A later reply", turnId: "turn-3" }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(1, {
      markdown: "What should I check instead?",
    });
    expect(post).toHaveBeenNthCalledWith(2, { markdown: "A later reply" });
  });

  it("does not suppress an interleaved task result", async () => {
    const { context, post } = handlerContext();

    await trackWorkerCancellation(
      workerCancellationResult("task-cancelled"),
      context,
      sessionContext()
    );
    await recordCancellationThroughHook(
      "session-1",
      "turn-cancelled",
      "Background task task-cancelled (worker) is cancelled."
    );
    await deliverCompletedMessage(
      completedEvent({
        message: "A different worker completed successfully.",
        turnId: "turn-success",
      }),
      context,
      sessionContext()
    );
    await deliverCompletedMessage(
      completedEvent({
        message: "The cancelled worker stopped.",
        turnId: "turn-cancelled",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "A different worker completed successfully.",
    });
  });

  it("delivers user-authored cancellation text from a newer Linq message", async () => {
    const original = handlerContext("message-1");
    await trackWorkerCancellation(
      workerCancellationResult(),
      original.context,
      sessionContext()
    );

    await recordCancellationThroughHook(
      "session-1",
      "turn-spoof",
      "Background task task-worker (worker) is cancelled."
    );
    const newer = handlerContext("message-2", original.state);
    await deliverCompletedMessage(
      completedEvent({
        message: "User-authored follow-up",
        turnId: "turn-spoof",
      }),
      newer.context,
      sessionContext()
    );

    expect(newer.post).toHaveBeenCalledExactlyOnceWith({
      markdown: "User-authored follow-up",
    });
  });

  it("retains older pending cancellations across many later tasks", async () => {
    const { context, post } = handlerContext();
    for (let index = 0; index < 60; index += 1) {
      await trackWorkerCancellation(
        workerCancellationResult(`task-${String(index)}`),
        context,
        sessionContext()
      );
    }
    await recordCancellationThroughHook(
      "session-1",
      "turn-oldest",
      "Background task task-0 (worker) is cancelled."
    );

    await deliverCompletedMessage(
      completedEvent({ message: "Redundant reply", turnId: "turn-oldest" }),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });
});

function workerCancellationResult(
  taskId = "task-worker"
): Parameters<ActionResultHandler>[0] {
  return {
    result: {
      callId: "call-cancel",
      kind: "tool-result",
      output: {
        tasks: [
          {
            metadata: {
              agentId: "ag_worker:test",
              kind: "subagent",
              mode: "local",
              name: "worker",
            },
            status: "cancelled",
            taskId,
          },
        ],
      },
      toolName: "task_cancel",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-1",
  };
}

function completedEvent(
  overrides: Partial<CompletedEvent> = {}
): CompletedEvent {
  return {
    finishReason: "stop",
    message: "Done",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-1",
    ...overrides,
  };
}

function handlerContext(
  currentMessageId = "message-1",
  state: Record<string, unknown> = {}
) {
  const post = vi.fn<(message: { markdown: string }) => Promise<void>>();
  post.mockResolvedValue();
  const addReaction = vi
    .fn<(threadId: string, messageId: string, emoji: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = {
    bot: {
      getAdapter: () => ({
        addReaction,
        decodeThreadId: () => ({ chatId: "chat-1", isGroup: false }),
      }),
    },
    state,
    thread: {
      id: "linq:dm:chat-1",
      post,
      toJSON: () => ({
        _type: "chat:Thread",
        adapterName: "linq",
        channelId: "linq:dm:chat-1",
        currentMessage: { id: currentMessageId },
        id: "linq:dm:chat-1",
        isDM: true,
      }),
    },
  } as unknown as HandlerContext;

  return {
    addReaction,
    context,
    post,
    state,
  };
}

function sessionContext(): SessionContext {
  return {
    session: { auth: {}, id: "session-1" },
  };
}

async function recordCancellationThroughHook(
  sessionId: string,
  turnId: string,
  message: string
) {
  const handler = workerCancellationHook.events?.["message.received"];
  if (!handler) throw new Error("Worker cancellation hook is not configured.");
  await handler(
    {
      data: { message, sequence: 0, turnId },
      meta: { at: "2026-08-27T20:00:00.000Z", id: `received-${turnId}` },
      type: "message.received",
    },
    {
      agent: { name: "root" },
      channel: { kind: "linq" },
      session: { id: sessionId },
    } as Parameters<typeof handler>[1]
  );
}
