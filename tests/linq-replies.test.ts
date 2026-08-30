import { describe, expect, it } from "vitest";
import {
  linqJobCardRepliesSchema,
  linqReplyToMessageId,
  rememberLinqJobCardReply,
  resolveLinqJobCardReply,
} from "../lib/goforay/linq-replies";

const card = {
  company: "OpenAI",
  location: "San Francisco, CA",
  reasons: ["Agent experience"],
  title: "Product Engineer",
  url: "https://openai.com/careers/example",
};

describe("Linq role-card replies", () => {
  it("resolves an iMessage threaded reply to the card it references", () => {
    const cards = rememberLinqJobCardReply({}, "role-message-2", card);

    expect(
      resolveLinqJobCardReply(
        { reply_to: { message_id: "role-message-2", part_index: 0 } },
        cards
      )
    ).toEqual(card);
  });

  it("does not treat an unthreaded message as a card selection", () => {
    expect(linqReplyToMessageId({ parts: [] })).toBeUndefined();
    expect(linqJobCardRepliesSchema.parse({ "role-message-2": card })).toEqual({
      "role-message-2": card,
    });
  });
});
