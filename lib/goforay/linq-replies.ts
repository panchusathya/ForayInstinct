import { z } from "zod";
import { goForayJobCardSchema, type GoForayJobCard } from "./job-cards";

const linqReplySchema = z.object({
  reply_to: z
    .object({ message_id: z.string().min(1).optional() })
    .nullable()
    .optional(),
});

export const linqJobCardRepliesSchema = z.record(
  z.string(),
  goForayJobCardSchema
);

/** The Linq webhook keeps a threaded-reply reference in its raw payload. */
export function linqReplyToMessageId(raw: unknown) {
  const parsed = linqReplySchema.safeParse(raw);
  return parsed.success ? parsed.data.reply_to?.message_id : undefined;
}

export function rememberLinqJobCardReply(
  previous: Record<string, GoForayJobCard>,
  messageId: string,
  card: GoForayJobCard
) {
  // Keep a small recent window so persisted channel state cannot grow without
  // bound while still allowing a candidate to reply to any card in a batch.
  return Object.fromEntries(
    [...Object.entries(previous), [messageId, card]].slice(-20)
  );
}

export function resolveLinqJobCardReply(
  raw: unknown,
  cardsByMessageId: Record<string, GoForayJobCard>
) {
  const messageId = linqReplyToMessageId(raw);
  return messageId ? cardsByMessageId[messageId] : undefined;
}
