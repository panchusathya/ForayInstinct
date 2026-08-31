/* oxlint-disable typescript/no-unsafe-type-assertion -- Eve's Linq adapter exposes the handler context through a transitive Chat SDK `any`; the fixture supplies only the fields exercised here. */
import type { chatSdkChannel } from "eve/channels/chat-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import workerCancellationHook from "../agent/hooks/worker-cancellation-delivery";
import { env } from "../lib/env";

const channelCapture = vi.hoisted(() => ({ config: undefined as unknown }));
const screenshotMocks = vi.hoisted(() => ({
  claimPendingApplicationSubmissionScreenshots: vi.fn<
    (_scope: unknown) => Promise<
      {
        applyUrl: string;
        id: number;
        kind: string;
        mimeType: string;
        png: Buffer;
        role: string;
        sessionId: string;
      }[]
    >
  >(),
  releaseApplicationSubmissionScreenshots:
    vi.fn<(_scope: unknown, _ids: readonly number[]) => Promise<void>>(),
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
        getState: () => ({
          delete: vi.fn<() => Promise<void>>(),
          setIfNotExists: vi.fn<() => Promise<boolean>>(),
        }),
        onDirectMessage: vi.fn<() => void>(),
        onNewMessage: vi.fn<() => void>(),
        onReaction: vi.fn<() => void>(),
      },
      channel: {},
      send: vi.fn<() => void>(),
    };
  },
}));
vi.mock("@/db/services/application-submission-screenshots", () => ({
  claimPendingApplicationSubmissionScreenshots:
    screenshotMocks.claimPendingApplicationSubmissionScreenshots,
  releaseApplicationSubmissionScreenshots:
    screenshotMocks.releaseApplicationSubmissionScreenshots,
}));
vi.mock("@/lib/goforay/request-job-card-png", () => ({
  renderJobCardPng: cardPngMocks.renderJobCardPng,
}));
import { readLinqJobCards } from "@/lib/goforay/linq-job-card-state";

await import("../agent/channels/linq-v2");

const channelEvents = (
  channelCapture.config as Parameters<typeof chatSdkChannel>[0]
).events;
const trackWorkerCancellation = channelEvents?.["action.result"];
const deliverCompletedMessage = channelEvents?.["message.completed"];
const requestAuthorization = channelEvents?.["authorization.required"];
if (!trackWorkerCancellation || !deliverCompletedMessage) {
  throw new Error("Linq event handlers are not configured.");
}
if (!requestAuthorization) {
  throw new Error("Linq does not override Eve's authorization prompt.");
}

type HandlerParameters = Parameters<typeof deliverCompletedMessage>;

describe("Linq message delivery", () => {
  beforeEach(() => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockReset();
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      []
    );
    screenshotMocks.releaseApplicationSubmissionScreenshots.mockReset();
    screenshotMocks.releaseApplicationSubmissionScreenshots.mockResolvedValue(
      undefined
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
    const { context, post, state, threadStore } = handlerContext();
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

    // Read it back the way a later turn or a tapback webhook would: a new
    // thread object over the same store, never the object that wrote it.
    const later = handlerContext(
      "message-later",
      {},
      undefined,
      undefined,
      threadStore
    );
    expect(
      await readLinqJobCards(
        later.context.thread as unknown as Parameters<
          typeof readLinqJobCards
        >[0]
      )
    ).toMatchObject({
      "linq-role-card-2": {
        company: "OpenAI",
        title: "Product Engineer",
        url: "https://openai.com/careers/example",
      },
    });
    // eve channel state must stay clean: writing there is what broke this.
    expect(state.linqJobCardsByMessageId).toBeUndefined();
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
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
          role: "Staff Engineer",
          sessionId: "browser-1",
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
      screenshotMocks.claimPendingApplicationSubmissionScreenshots
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
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
          role: "Staff Engineer",
          sessionId: "browser-1",
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

  it("keeps explicitly identified SMS on the text confirmation when a screenshot is available", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "submitted",
          mimeType: "image/png",
          png: Buffer.from("png-bytes"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
    );
    const { context, post } = handlerContext("message-1", {}, "SMS");

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
      screenshotMocks.claimPendingApplicationSubmissionScreenshots
    ).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "applied to staff engineer at acme.",
    });
  });

  it("posts every review slice before the candidate approves a submission", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("top"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
        {
          applyUrl: "https://example.com/apply",
          id: 2,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("bottom"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
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
        "Before I submit staff engineer — page 1 of 2. Reply *yes* to submit, or tell me what to change.",
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
        "Before I submit staff engineer — page 2 of 2. Reply *yes* to submit, or tell me what to change.",
    });
    expect(post).toHaveBeenNthCalledWith(3, {
      markdown: "ready to submit staff engineer at acme. reply yes.",
    });
  });

  it("delivers a review when the worker result and coordinator completion use different turns", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("review"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");
    const workerResult = submissionApprovalResult();
    workerResult.turnId = "worker-turn";

    await trackWorkerCancellation(
      workerResult,
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );
    await deliverCompletedMessage(
      completedEvent({
        message: "Ready to submit Staff Engineer at Acme. Reply yes.",
        turnId: "coordinator-turn",
      }),
      context,
      sessionContext({ id: "user-1", workspaceId: "workspace-1" })
    );

    expect(post).toHaveBeenNthCalledWith(1, {
      files: [
        {
          data: Buffer.from("review"),
          filename: "application-review-1.png",
          mimeType: "image/png",
        },
      ],
      markdown:
        "Before I submit staff engineer. Reply *yes* to submit, or tell me what to change.",
    });
  });

  it("tries to deliver a review when Linq omits the transport label", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("review"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
    );
    const { context, post } = handlerContext();

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

    expect(post).toHaveBeenNthCalledWith(1, {
      files: [
        {
          data: Buffer.from("review"),
          filename: "application-review-1.png",
          mimeType: "image/png",
        },
      ],
      markdown:
        "Before I submit staff engineer. Reply *yes* to submit, or tell me what to change.",
    });
  });

  it("re-offers a review slice whose upload failed instead of losing it", async () => {
    // Claiming stamps `deliveredAt` before anything is posted, so a failed
    // upload used to destroy the review while the candidate was still asked to
    // reply yes. The ids have to go back so the next turn can re-offer them.
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 41,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("top"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
        {
          applyUrl: "https://example.com/apply",
          id: 42,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("bottom"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");
    // Page one uploads, page two fails: a partial review is worse than none,
    // because the candidate approves having seen only half the form.
    post.mockImplementation((message: unknown) =>
      Buffer.from("bottom").equals(attachedBytes(message))
        ? Promise.reject(new Error("media upload rejected"))
        : Promise.resolve({ id: "posted" })
    );

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

    expect(
      screenshotMocks.releaseApplicationSubmissionScreenshots
    ).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      [42]
    );
    // A partial review is the dangerous case: page one is on screen, so the
    // candidate has no reason to think they are missing the rest of the form.
    const posted = post.mock.calls.map(([message]) => postedMarkdown(message));
    expect(posted).toContain(
      "heads up, i could only send you part of the filled form for staff engineer.\n\ntell me to walk you through it and i will read the answers back before anything is submitted."
    );
  });

  it("says the form could not be sent rather than asking for a blind approval", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 51,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("top"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
    );
    const { context, post } = handlerContext("message-1", {}, "iMessage");
    post.mockImplementation((message: unknown) =>
      attachedBytes(message).byteLength > 0
        ? Promise.reject(new Error("media upload rejected"))
        : Promise.resolve({ id: "posted" })
    );

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

    expect(
      screenshotMocks.releaseApplicationSubmissionScreenshots
    ).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      [51]
    );
    // Nothing reached the thread, so the candidate must be told, not left with
    // the coordinator's "reply yes" standing on its own.
    const posted = post.mock.calls.map(([message]) => postedMarkdown(message));
    expect(posted).toContain(
      "i could not send you the filled form for staff engineer.\n\ntell me to walk you through it and i will read the answers back before anything is submitted."
    );
  });

  it("leaves an ordinary worker failure without a screenshot post", async () => {
    screenshotMocks.claimPendingApplicationSubmissionScreenshots.mockResolvedValue(
      [
        {
          applyUrl: "https://example.com/apply",
          id: 1,
          kind: "review",
          mimeType: "image/png",
          png: Buffer.from("top"),
          role: "Staff Engineer",
          sessionId: "browser-1",
        },
      ]
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
      screenshotMocks.claimPendingApplicationSubmissionScreenshots
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

describe("Linq authorization prompts", () => {
  const authorizationEvent = (overrides: Record<string, unknown> = {}) =>
    ({
      authorization: {
        displayName: "Google",
        instructions: "Open the link and enter the code.",
        url: "https://connect.vercel.com",
        userCode: "PHV-HMB",
      },
      description: "Authorization required for Google.",
      name: "google",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
      ...overrides,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture supplies only the event fields this handler reads.
    }) as unknown as Parameters<typeof requestAuthorization>[0];

  it("asks the candidate to connect on the web instead of sending a pairing code", async () => {
    const { context, post, state } = handlerContext();

    await requestAuthorization(authorizationEvent(), context, sessionContext());

    const posted = post.mock.calls
      .map(([message]) => (message as { markdown: string }).markdown)
      .join("\n");
    // A device-pairing code reaches iMessage as an unusable run-together line,
    // and it is never the answer to a task already in flight.
    expect(posted).not.toContain("PHV-HMB");
    expect(posted).not.toContain("connect.vercel.com");
    expect(posted).toContain("google");
    expect(posted).toContain(new URL("/", env.BETTER_AUTH_URL).toString());
    expect(state.authorizationNoticesSent).toEqual({ google: true });
  });

  it("asks once per connection", async () => {
    const { context, post } = handlerContext();

    await requestAuthorization(authorizationEvent(), context, sessionContext());
    const afterFirst = post.mock.calls.length;
    await requestAuthorization(authorizationEvent(), context, sessionContext());

    expect(post.mock.calls.length).toBe(afterFirst);
  });

  it("leaves an approval candidate to the approval handlers", async () => {
    const { context, post } = handlerContext();

    await requestAuthorization(
      authorizationEvent({ candidateId: "candidate-1" }),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });
});

function handlerContext(
  currentMessageId = "message-1",
  state: Record<string, unknown> = {},
  lastService?: string,
  raw?: unknown,
  threadStore = new Map<string, Record<string, unknown>>()
) {
  const post = vi.fn<(message: unknown) => Promise<unknown>>();
  post.mockResolvedValue(undefined);
  const threadId = "linq:dm:chat-1";
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
      id: threadId,
      post,
      // Chat SDK thread state. A card mapping written here has to be readable
      // by a later turn and by a reaction webhook, which each get a *different*
      // thread object and share only the backing store.
      get state() {
        return Promise.resolve(threadStore.get(threadId));
      },
      setState(patch: Record<string, unknown>) {
        threadStore.set(threadId, { ...threadStore.get(threadId), ...patch });
        return Promise.resolve(undefined);
      },
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
    threadStore,
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

/** The bytes a posted message attached, or empty when it was text only. */
function attachedBytes(message: unknown) {
  const parsed = z
    .object({ files: z.array(z.object({ data: z.instanceof(Buffer) })).min(1) })
    .safeParse(message);
  return parsed.success
    ? (parsed.data.files[0]?.data ?? Buffer.alloc(0))
    : Buffer.alloc(0);
}

function postedMarkdown(message: unknown) {
  const parsed = z.object({ markdown: z.string() }).safeParse(message);
  return parsed.success ? parsed.data.markdown : undefined;
}
