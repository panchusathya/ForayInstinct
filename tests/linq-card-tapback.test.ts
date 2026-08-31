/* oxlint-disable typescript/no-unsafe-type-assertion -- the fixtures supply only the Chat SDK fields the handler reads. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  claims: new Map<string, unknown>(),
  reaction: undefined as ((event: unknown) => Promise<void>) | undefined,
  reactionFilter: undefined as unknown,
  send: vi.fn<(input: unknown, options: unknown) => Promise<void>>(),
}));
const bridge = vi.hoisted(() => ({
  linkCandidate: vi.fn<() => Promise<void>>(),
  recordConversationMessage: vi.fn<() => Promise<void>>(),
}));

vi.mock("eve/channels/chat-sdk", () => ({
  chatSdkChannel() {
    return {
      bot: {
        getState: () => ({
          delete: (key: string) => {
            capture.claims.delete(key);
            return Promise.resolve();
          },
          setIfNotExists: (key: string, value: unknown) => {
            if (capture.claims.has(key)) return Promise.resolve(false);
            capture.claims.set(key, value);
            return Promise.resolve(true);
          },
        }),
        onDirectMessage: vi.fn<() => void>(),
        onNewMessage: vi.fn<() => void>(),
        onReaction(
          filter: unknown,
          handler: (event: unknown) => Promise<void>
        ) {
          capture.reactionFilter = filter;
          capture.reaction = handler;
        },
      },
      channel: {},
      send: capture.send,
    };
  },
}));
vi.mock("@/lib/goforay/bridge", () => ({
  linkCandidate: bridge.linkCandidate,
  recordConversationMessage: bridge.recordConversationMessage,
}));
vi.mock("@/lib/goforay/request-job-card-png", () => ({
  renderJobCardPng: vi.fn<() => Promise<undefined>>(),
}));

await import("../agent/channels/linq-v2");

const card = {
  company: "Ramp",
  location: "New York, NY",
  reasons: ["matches fp&a"],
  title: "Head of FP&A",
  url: "https://jobs.ashbyhq.com/ramp/2f1c9a44-1b2e",
};

function threadFixture(cards: Record<string, unknown> = {}) {
  const post = vi
    .fn<(message: unknown) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const store: Record<string, unknown> = {
    linqJobCardsByMessageId: cards,
  };
  return {
    post,
    thread: {
      id: "linq:chat-1",
      post,
      get state() {
        return Promise.resolve(store);
      },
      setState: (patch: Record<string, unknown>) => {
        Object.assign(store, patch);
        return Promise.resolve(undefined);
      },
    },
  };
}

function reactionEvent(overrides: Record<string, unknown> = {}) {
  const { post, thread } = threadFixture({ "card-message-2": card });
  return {
    event: {
      added: true,
      emoji: { name: "thumbs_up" },
      messageId: "card-message-2",
      raw: {},
      rawEmoji: "like",
      thread,
      threadId: "linq:chat-1",
      user: {
        fullName: "+12025550123",
        isBot: false,
        isMe: false,
        userId: "+12025550123",
        userName: "+12025550123",
      },
      ...overrides,
    },
    post,
    thread,
  };
}

async function fire(overrides: Record<string, unknown> = {}) {
  const fixture = reactionEvent(overrides);
  await capture.reaction?.(fixture.event);
  return fixture;
}

describe("Linq job-card tapback", () => {
  beforeEach(() => {
    capture.claims.clear();
    capture.send.mockClear();
    capture.send.mockResolvedValue(undefined);
    bridge.recordConversationMessage.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("registers for thumbs-up only", () => {
    // A catch-all registration would fire on every heart and every laugh.
    expect(capture.reactionFilter).toEqual(["thumbs_up"]);
  });

  it("applies to the role the card belongs to", async () => {
    const { post } = await fire();

    expect(capture.send).toHaveBeenCalledTimes(1);
    const [input, options] = capture.send.mock.calls[0] ?? [];
    expect(input).toMatchObject({ message: "apply to this" });
    expect(JSON.stringify(input)).toContain(card.url);
    // Steering would cancel the previous application on a second tapback.
    expect(options).toMatchObject({ turnPolicy: "queue" });
    const auth = (
      options as {
        auth: { attributes: { workspaceId: string }; principalId: string };
      }
    ).auth;
    expect(auth.attributes.workspaceId).toMatch(/^phone:/u);
    // The principal id is the Vercel Connect subject. A text forwards the
    // phone-derived id; a tapback used to forward Linq's own, so a Google grant
    // made on the web was invisible and every Gmail call asked the candidate to
    // authorize Google again. Both paths must agree.
    expect(auth.principalId).toBe(auth.attributes.workspaceId);
    // Naming the role is how a wrong mapping becomes visible immediately.
    expect(post).toHaveBeenCalledExactlyOnceWith({
      markdown: "on it, applying to head of fp&a at ramp",
    });
  });

  it("ignores a tapback on a message that is not a card", async () => {
    const { post } = await fire({ messageId: "some-other-message" });
    expect(capture.send).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores a removed tapback and does not burn the claim", async () => {
    const { post } = await fire({ added: false });
    expect(capture.send).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(capture.claims.size).toBe(0);
  });

  it("ignores our own reaction", async () => {
    await fire({
      user: { isBot: false, isMe: true, userName: "+12025550123" },
    });
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("ignores another bot", async () => {
    await fire({
      user: { isBot: true, isMe: false, userName: "+12025550123" },
    });
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("treats an unknown bot flag as a real candidate", async () => {
    // Linq derives `isBot` from `is_from_me`, so "unknown" is the common case.
    await fire({
      user: { isBot: "unknown", isMe: false, userName: "+12025550123" },
    });
    expect(capture.send).toHaveBeenCalledTimes(1);
  });

  it("applies once when the webhook is delivered twice", async () => {
    await fire();
    await fire();
    expect(capture.send).toHaveBeenCalledTimes(1);
  });

  it("applies once across a remove and a re-add", async () => {
    await fire();
    await fire({ added: false });
    await fire();
    expect(capture.send).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the turn fails to start", async () => {
    capture.send.mockRejectedValueOnce(new Error("session unavailable"));
    await fire();
    expect(capture.claims.size).toBe(0);

    // So the candidate can simply tapback again.
    await fire();
    expect(capture.send).toHaveBeenCalledTimes(2);
  });

  it("falls back to a user scope when the handle is not a phone number", async () => {
    await fire({
      user: { isBot: false, isMe: false, userName: "not-a-phone" },
    });
    expect(capture.send).toHaveBeenCalledTimes(1);
    const options = capture.send.mock.calls[0]?.[1] as {
      auth: { attributes: { workspaceId: string } };
    };
    expect(options.auth.attributes.workspaceId).toMatch(/^personal:/u);
  });
});
