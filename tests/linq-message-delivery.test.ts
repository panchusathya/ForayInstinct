/* oxlint-disable typescript/no-unsafe-type-assertion -- Eve's Linq adapter exposes the handler context through a transitive Chat SDK `any`; the fixture supplies only the fields exercised here. */
import type { chatSdkChannel } from "eve/channels/chat-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import workerCancellationHook from "../agent/hooks/worker-cancellation-delivery";

const channelCapture = vi.hoisted(() => ({ config: undefined as unknown }));
const screenshotMocks = vi.hoisted(() => ({
  consumeLatestApplicationSubmissionScreenshot:
    vi.fn<
      (
        _scope: unknown
      ) => Promise<{ mimeType: string; png: Buffer } | undefined>
    >(),
}));
vi.mock("eve/channels/chat-sdk", () => ({
  chatSdkChannel(config: unknown) {
    channelCapture.config = config;
    return {
      bot: {
        onDirectMessage: vi.fn<() => void>(),
        onNewMessage: vi.fn<() => void>(),
      },
      channel: {},
      send: vi.fn<() => void>(),
    };
  },
}));
vi.mock("@/db/services/application-submission-screenshots", () => ({
  consumeLatestApplicationSubmissionScreenshot:
    screenshotMocks.consumeLatestApplicationSubmissionScreenshot,
}));
await import("../agent/channels/linq-v2");

const channelEvents = (
  channelCapture.config as Parameters<typeof chatSdkChannel>[0]
).events;
const trackWorkerCancellation = channelEvents?.["action.result"];
const deliverCompletedMessage = channelEvents?.["message.completed"];
if (!trackWorkerCancellation || !deliverCompletedMessage) {
  throw new Error("Linq event handlers are not configured.");
}

type HandlerParameters = Parameters<typeof deliverCompletedMessage>;

describe("Linq message delivery", () => {
  beforeEach(() => {
    screenshotMocks.consumeLatestApplicationSubmissionScreenshot.mockReset();
  });

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

    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: message.toLowerCase(),
    });
  });

  it("delivers Exa role cards with their apply URL instead of the model reply", async () => {
    const { context, post } = handlerContext();

    await trackWorkerCancellation(
      {
        result: {
          callId: "call-roles",
          kind: "tool-result",
          output: {
            cards: [
              {
                company: "The Toro Company",
                location: "Remote, USA",
                reasons: ["M&A modeling"],
                title: "Sr. Analyst, Corporate Development",
                url: "https://jobs.thetorocompany.com/job/bloomington/corp-dev/1",
              },
            ],
            source: "exa",
          },
          toolName: "find_goforay_roles",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-1",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({
        message: "here is a toro role without a link",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown:
        '1/1  sr. analyst, corporate development · the toro company\nremote, usa\n· m&a modeling\nhttps://jobs.thetorocompany.com/job/bloomington/corp-dev/1\nreply "apply 1" to apply',
    });
  });

  it("suppresses intermediate tool-call messages without a generic reaction", async () => {
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
    expect(addReaction).not.toHaveBeenCalled();
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
      markdown: "what should i check instead?",
    });
    expect(post).toHaveBeenNthCalledWith(2, { markdown: "a later reply" });
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
      markdown: "a different worker completed successfully.",
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
      markdown: "user-authored follow-up",
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

  it("posts a confirmation screenshot on rich iMessage after a submitted report", async () => {
    screenshotMocks.consumeLatestApplicationSubmissionScreenshot.mockResolvedValue(
      {
        mimeType: "image/png",
        png: Buffer.from("png-bytes"),
      }
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");

    await trackWorkerCancellation(
      submittedApplicationResult(),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    await deliverCompletedMessage(
      completedEvent({ message: "Applied to Staff Engineer at Acme." }),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    expect(
      screenshotMocks.consumeLatestApplicationSubmissionScreenshot
    ).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(post).toHaveBeenNthCalledWith(1, {
      files: [
        {
          data: Buffer.from("png-bytes"),
          filename: "application-submitted.png",
          mimeType: "image/png",
        },
      ],
      markdown: "",
    });
    expect(post).toHaveBeenNthCalledWith(2, {
      markdown: "applied to staff engineer at acme.",
    });
  });

  it("keeps SMS on the text confirmation when a screenshot is available", async () => {
    screenshotMocks.consumeLatestApplicationSubmissionScreenshot.mockResolvedValue(
      {
        mimeType: "image/png",
        png: Buffer.from("png-bytes"),
      }
    );
    const { context, post } = handlerContext();

    await trackWorkerCancellation(
      submittedApplicationResult(),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    await deliverCompletedMessage(
      completedEvent({ message: "Applied to Staff Engineer at Acme." }),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    expect(
      screenshotMocks.consumeLatestApplicationSubmissionScreenshot
    ).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "applied to staff engineer at acme.",
    });
  });
});

function submittedApplicationResult(): Parameters<
  NonNullable<typeof trackWorkerCancellation>
>[0] {
  return {
    result: {
      callId: "call-submit",
      kind: "tool-result",
      output: { status: "success", message: "submitted" },
      toolName: "worker",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-1",
  };
}

function workerCancellationResult(
  taskId = "task-worker"
): Parameters<NonNullable<typeof trackWorkerCancellation>>[0] {
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
  overrides: Partial<HandlerParameters[0]> = {}
): HandlerParameters[0] {
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
  state: Record<string, unknown> = {},
  lastService?: string
) {
  const post = vi.fn<(message: string) => Promise<void>>();
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
        ...(lastService ? { lastService } : {}),
      }),
    },
  } as unknown as HandlerParameters[1];

  return {
    addReaction,
    context,
    post,
    state,
  };
}

function sessionContext(auth?: { id: string; workspaceId: string }) {
  return {
    session: {
      id: "session-1",
      ...(auth
        ? {
            auth: {
              current: {
                attributes: { workspaceId: auth.workspaceId },
                id: auth.id,
              },
            },
          }
        : {}),
    },
  } as unknown as HandlerParameters[2];
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
