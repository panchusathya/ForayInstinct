import { z } from "zod";
import {
  linqJobCardRepliesSchema,
  rememberLinqJobCardReply,
} from "./linq-replies";
import type { GoForayJobCard } from "./job-cards";

/**
 * Which role each delivered card message is, so a reply or a thumbs-up on that
 * message resolves back to the role.
 *
 * This module owns both the key and both accessors on purpose. The mapping used
 * to be written to eve's channel state and read from Chat SDK thread state —
 * two different stores — so replying to a card never resolved anything in
 * production, and no unit test could see it because the test asserted against
 * the object it had injected. Keeping the read and the write in one file is what
 * stops that drifting apart again.
 */

const LINQ_JOB_CARDS_KEY = "linqJobCardsByMessageId";

/** Structural, so the channel's state helpers stay out of the Chat SDK types. */
export interface LinqJobCardThread {
  /** `unknown` because the Chat SDK does not type its state payload. */
  readonly state: Promise<unknown>;
  setState: (patch: Record<string, unknown>) => Promise<unknown>;
}

const threadStateSchema = z.object({
  [LINQ_JOB_CARDS_KEY]: linqJobCardRepliesSchema,
});

export async function readLinqJobCards(thread: LinqJobCardThread) {
  try {
    const parsed = threadStateSchema.safeParse(await thread.state);
    return parsed.success ? parsed.data[LINQ_JOB_CARDS_KEY] : {};
  } catch (error) {
    console.warn("[goforay] linq card state unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Records one card and returns the merged map, so a delivery loop can keep
 * writing without re-reading. Writing per post rather than once at the end means
 * a failure part-way through a batch still keeps the cards already sent.
 */
export async function rememberLinqJobCard(
  thread: LinqJobCardThread,
  previous: Record<string, GoForayJobCard>,
  messageId: string,
  card: GoForayJobCard
) {
  const next = rememberLinqJobCardReply(previous, messageId, card);
  try {
    await thread.setState({ [LINQ_JOB_CARDS_KEY]: next });
  } catch (error) {
    console.warn("[goforay] could not persist a linq card mapping", {
      message: error instanceof Error ? error.message : String(error),
      messageId,
    });
  }
  return next;
}

export function linqJobCardForMessageId(
  cards: Record<string, GoForayJobCard>,
  messageId: string | undefined
) {
  return messageId ? cards[messageId] : undefined;
}
