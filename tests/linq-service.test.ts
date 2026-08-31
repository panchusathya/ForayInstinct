import { describe, expect, it } from "vitest";
import {
  isRichLinqService,
  linqServiceFromUnknown,
  normalizeLinqService,
} from "@/lib/goforay/linq-service";

describe("linq service", () => {
  it("normalizes webhook spellings", () => {
    expect(normalizeLinqService("iMessage")).toBe("iMessage");
    expect(normalizeLinqService("imessage")).toBe("iMessage");
    expect(normalizeLinqService("RCS")).toBe("RCS");
    expect(normalizeLinqService("sms")).toBe("SMS");
    expect(normalizeLinqService("")).toBe("");
    expect(normalizeLinqService("auto")).toBe("");
  });

  it("reads service from a Chat SDK thread JSON that only has the inbound raw payload", () => {
    expect(
      linqServiceFromUnknown({
        _type: "chat:Thread",
        adapterName: "linq",
        currentMessage: {
          id: "message-1",
          raw: {
            chat: { id: "chat-1", is_group: false },
            direction: "inbound",
            id: "msg-1",
            service: "iMessage",
          },
        },
        id: "linq:dm:chat-1",
      })
    ).toBe("iMessage");
  });

  it("does not treat a serialized thread without a protocol as rich", () => {
    expect(
      linqServiceFromUnknown({
        _type: "chat:Thread",
        adapterName: "linq",
        currentMessage: { id: "message-1" },
        id: "linq:dm:chat-1",
      })
    ).toBe("");
    expect(isRichLinqService("")).toBe(false);
    expect(isRichLinqService("iMessage")).toBe(true);
    expect(isRichLinqService("SMS")).toBe(false);
  });
});
