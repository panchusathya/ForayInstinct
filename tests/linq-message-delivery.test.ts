/* oxlint-disable typescript/no-unsafe-type-assertion -- Eve's Linq adapter exposes the handler context through a transitive Chat SDK `any`; the fixture supplies only the fields exercised here. */
import type { chatSdkChannel } from "eve/channels/chat-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import workerCancellationHook from "../agent/hooks/worker-cancellation-delivery";

const channelCapture = vi.hoisted(() => ({ config: undefined as unknown }));
const screenshotMocks = vi.hoisted(() => ({
  consumePendingApplicationSubmissionScreenshots:
    vi.fn<
      (
        _scope: unknown
      ) => Promise<{ kind: string; mimeType: string; png: Buffer }[]>
    >(),
}));
const cardPngMocks = vi.hoisted(() => ({
  renderJobCardPng:
    vi.fn<() => Promise<{ bytes: Buffer; filename: string } | undefined>>(),
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
  consumePendingApplicationSubmissionScreenshots:
    screenshotMocks.consumePendingApplicationSubmissionScreenshots,
}));
vi.mock("@/lib/goforay/request-job-card-png", () => ({
  renderJobCardPng: cardPngMocks.renderJobCardPng,
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
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockReset();
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      []
    );
    cardPngMocks.renderJobCardPng.mockReset();
    cardPngMocks.renderJobCardPng.mockResolvedValue(undefined);
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

  it("attaches a local PNG as the card on rich Linq threads", async () => {
    cardPngMocks.renderJobCardPng.mockResolvedValueOnce({
      bytes: Buffer.from("png-bytes"),
      filename: "the-toro-company-role.png",
    });
    const { context, post } = handlerContext("message-1", {}, "iMessage");

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
        turnId: "turn-png",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({
        message: "here is a toro role",
        turnId: "turn-png",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from("png-bytes"),
          filename: "the-toro-company-role.png",
          mimeType: "image/png",
        },
      ],
      markdown: "",
    });
  });

  it("treats a Linq webhook service on the inbound message as iMessage", async () => {
    cardPngMocks.renderJobCardPng.mockResolvedValueOnce({
      bytes: Buffer.from("png-bytes"),
      filename: "the-toro-company-role.png",
    });
    const { context, post } = handlerContext("message-1", {}, undefined, {
      chat: { id: "chat-1", is_group: false },
      direction: "inbound",
      id: "msg-1",
      service: "iMessage",
    });

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
        turnId: "turn-webhook-service",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({
        message: "here is a toro role",
        turnId: "turn-webhook-service",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from("png-bytes"),
          filename: "the-toro-company-role.png",
          mimeType: "image/png",
        },
      ],
      markdown: "",
    });
  });

  it("keeps the text twin on SMS even when a PNG could be rendered", async () => {
    cardPngMocks.renderJobCardPng.mockResolvedValueOnce({
      bytes: Buffer.from("png-bytes"),
      filename: "the-toro-company-role.png",
    });
    const { context, post } = handlerContext("message-1", {}, "SMS");

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
          },
          toolName: "find_goforay_roles",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-sms",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({ message: "role cards", turnId: "turn-sms" }),
      context,
      sessionContext()
    );

    expect(cardPngMocks.renderJobCardPng).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown:
        '1/1  sr. analyst, corporate development · the toro company\nremote, usa\n· m&a modeling\nhttps://jobs.thetorocompany.com/job/bloomington/corp-dev/1\nreply "apply 1" to apply',
    });
  });

  it("falls back to the text twin when PNG rendering throws", async () => {
    cardPngMocks.renderJobCardPng.mockRejectedValueOnce(
      new Error("satori failed")
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");

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
          },
          toolName: "find_goforay_roles",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-png-throw",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({ message: "role cards", turnId: "turn-png-throw" }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown:
        '1/1  sr. analyst, corporate development · the toro company\nremote, usa\n· m&a modeling\nhttps://jobs.thetorocompany.com/job/bloomington/corp-dev/1\nreply "apply 1" to apply',
    });
  });

  it("falls back to the text twin when PNG rendering fails", async () => {
    const { context, post } = handlerContext("message-1", {}, "iMessage");

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
          },
          toolName: "find_goforay_roles",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-png-miss",
      },
      context,
      sessionContext()
    );

    await deliverCompletedMessage(
      completedEvent({ message: "role cards", turnId: "turn-png-miss" }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown:
        '1/1  sr. analyst, corporate development · the toro company\nremote, usa\n· m&a modeling\nhttps://jobs.thetorocompany.com/job/bloomington/corp-dev/1\nreply "apply 1" to apply',
    });
  });

  it("remembers the provider message id for a role-card threaded reply", async () => {
    const { context, post, state } = handlerContext();
    post.mockResolvedValueOnce({ id: "linq-role-card-2" });

    await trackWorkerCancellation(
      {
        result: {
          callId: "call-roles",
          kind: "tool-result",
          output: {
            cards: [
              {
                company: "OpenAI",
                location: "San Francisco, CA",
                reasons: ["Agent experience"],
                title: "Product Engineer",
                url: "https://openai.com/careers/example",
              },
            ],
          },
          toolName: "find_goforay_roles",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-role-reply",
      },
      context,
      sessionContext()
    );
    await deliverCompletedMessage(
      completedEvent({ message: "role cards", turnId: "turn-role-reply" }),
      context,
      sessionContext()
    );

    expect(state.linqJobCardsByMessageId).toMatchObject({
      "linq-role-card-2": {
        company: "OpenAI",
        title: "Product Engineer",
        url: "https://openai.com/careers/example",
      },
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
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
        },
      ]
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
      screenshotMocks.consumePendingApplicationSubmissionScreenshots
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

  it("posts a confirmation screenshot when only the inbound webhook names iMessage", async () => {
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
        },
      ]
    );
    const { context, state } = handlerContext("message-1", {}, undefined, {
      direction: "inbound",
      id: "msg-1",
      service: "iMessage",
    });

    await trackWorkerCancellation(
      submittedApplicationResult(),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    expect(state.lastLinqService).toBe("iMessage");

    // Worker completion is a later turn; Chat SDK no longer serializes the
    // inbound webhook, so delivery has to reuse the stamped protocol.
    const later = handlerContext("message-later", state);
    await deliverCompletedMessage(
      completedEvent({ message: "Applied to Staff Engineer at Acme." }),
      later.context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    expect(later.post).toHaveBeenNthCalledWith(1, {
      files: [
        {
          data: Buffer.from("png-bytes"),
          filename: "application-submitted.png",
          mimeType: "image/png",
        },
      ],
      markdown: "",
    });
  });

  it("keeps SMS on the text confirmation when a screenshot is available", async () => {
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
        },
      ]
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
      screenshotMocks.consumePendingApplicationSubmissionScreenshots
    ).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "applied to staff engineer at acme.",
    });
  });

  it("posts every review slice before the candidate approves a submission", async () => {
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        { kind: "review", mimeType: "image/png", png: Buffer.from("top") },
        { kind: "review", mimeType: "image/png", png: Buffer.from("bottom") },
      ]
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");

    await trackWorkerCancellation(
      submissionApprovalResult(),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    await deliverCompletedMessage(
      completedEvent({
        message: "Ready to submit Staff Engineer at Acme. Reply yes.",
      }),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    // The pause is a `failure` status, so delivery has to be armed off the
    // blocker prefix rather than a successful worker result.
    expect(post).toHaveBeenNthCalledWith(1, {
      files: [
        {
          data: Buffer.from("top"),
          filename: "application-review-1.png",
          mimeType: "image/png",
        },
      ],
      markdown:
        "Before I submit — page 1 of 2. Reply *yes* to submit, or tell me what to change.",
    });
    expect(post).toHaveBeenNthCalledWith(2, {
      files: [
        {
          data: Buffer.from("bottom"),
          filename: "application-review-2.png",
          mimeType: "image/png",
        },
      ],
      markdown:
        "Before I submit — page 2 of 2. Reply *yes* to submit, or tell me what to change.",
    });
    expect(post).toHaveBeenNthCalledWith(3, {
      markdown: "ready to submit staff engineer at acme. reply yes.",
    });
  });

  it("leaves an ordinary worker failure without a screenshot post", async () => {
    screenshotMocks.consumePendingApplicationSubmissionScreenshots.mockResolvedValue(
      [{ kind: "review", mimeType: "image/png", png: Buffer.from("top") }]
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");

    await trackWorkerCancellation(
      submissionApprovalResult("Needs user input: what is your start date?"),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    await deliverCompletedMessage(
      completedEvent({ message: "When can you start?" }),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    expect(
      screenshotMocks.consumePendingApplicationSubmissionScreenshots
    ).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "when can you start?",
    });
  });
});

function submissionApprovalResult(
  message = "Needs submission approval: Staff Engineer at Acme."
): Parameters<NonNullable<typeof trackWorkerCancellation>>[0] {
  return {
    result: {
      callId: "call-approve",
      kind: "tool-result",
      output: { message, status: "failure" },
      toolName: "worker",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-1",
  };
}

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
  lastService?: string,
  raw?: unknown
) {
  const post = vi.fn<(message: unknown) => Promise<unknown>>();
  post.mockResolvedValue(undefined);
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
        currentMessage: {
          id: currentMessageId,
          ...(raw === undefined ? {} : { raw }),
        },
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
