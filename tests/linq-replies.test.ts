import { describe, expect, it, vi } from "vitest";
import type { GoForayJobCard } from "../lib/goforay/job-cards";
import {
  linqJobCardForMessageId,
  readLinqJobCards,
  rememberLinqJobCard,
} from "../lib/goforay/linq-job-card-state";
import {
  linqJobCardRepliesSchema,
  linqReplyToMessageId,
  rememberLinqJobCardReply,
} from "../lib/goforay/linq-replies";

const card = {
  company: "OpenAI",
  location: "San Francisco, CA",
  reasons: ["Agent experience"],
  title: "Product Engineer",
  url: "https://openai.com/careers/example",
};

/** Stands in for a Chat SDK thread backed by the shared state adapter. */
function threadFixture(store = new Map<string, Record<string, unknown>>()) {
  const id = "linq:dm:chat-1";
  return {
    store,
    thread: {
      get state() {
        return Promise.resolve(store.get(id));
      },
      setState(patch: Record<string, unknown>) {
        store.set(id, { ...store.get(id), ...patch });
        return Promise.resolve(undefined);
      },
    },
  };
}

describe("Linq role-card replies", () => {
  it("resolves a threaded reply to the card it references", async () => {
    const { thread } = threadFixture();
    await rememberLinqJobCard(thread, {}, "role-message-2", card);

    expect(
      linqJobCardForMessageId(
        await readLinqJobCards(thread),
        linqReplyToMessageId({
          reply_to: { message_id: "role-message-2", part_index: 0 },
        })
      )
    ).toEqual(card);
  });

  it("does not treat an unthreaded message as a card selection", () => {
    expect(linqReplyToMessageId({ parts: [] })).toBeUndefined();
    expect(linqJobCardRepliesSchema.parse({ "role-message-2": card })).toEqual({
      "role-message-2": card,
    });
  });

  it("keeps other thread state when recording a card", async () => {
    const { store, thread } = threadFixture();
    await thread.setState({ lastLinqService: "iMessage" });
    await rememberLinqJobCard(thread, {}, "role-message-2", card);

    expect(store.get("linq:dm:chat-1")?.lastLinqService).toBe("iMessage");
    expect(await readLinqJobCards(thread)).toEqual({
      "role-message-2": card,
    });
  });

  it("holds a wide enough window for several batches of five", () => {
    let cards: Record<string, GoForayJobCard> = {};
    for (let index = 0; index < 60; index += 1) {
      cards = rememberLinqJobCardReply(cards, `role-${String(index)}`, card);
    }
    expect(Object.keys(cards)).toHaveLength(50);
    expect(cards["role-59"]).toEqual(card);
    expect(cards["role-9"]).toBeUndefined();
  });

  it("survives a state store that is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      get state() {
        return Promise.reject(new Error("no connection"));
      },
      setState: () => Promise.reject(new Error("no connection")),
    };

    // Dedupe bookkeeping must never take a role delivery down with it.
    await expect(readLinqJobCards(broken)).resolves.toEqual({});
    await expect(
      rememberLinqJobCard(broken, {}, "role-message-2", card)
    ).resolves.toEqual({ "role-message-2": card });
    vi.restoreAllMocks();
  });
});
