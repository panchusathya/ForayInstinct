import { z } from "zod";
import type { LinqJobCardThread } from "./linq-job-card-state";

/**
 * The inbound message whose review the webhook already posted.
 *
 * The inbound webhook flushes a stranded review before the model runs, and it
 * has no channel state to say so. Left unsaid, the turn that followed added
 * the coordinator's written recap of a form the candidate was already looking
 * at, and set a retry marker for a capture that had just been delivered. Same
 * store as the job-card mapping, for the same reason: one place to read and
 * write, so the two cannot drift apart.
 */
const LINQ_REVIEW_DELIVERED_KEY = "linqReviewDeliveredForMessageId";

const threadStateSchema = z.object({
  [LINQ_REVIEW_DELIVERED_KEY]: z.string(),
});

export async function rememberLinqReviewDelivered(
  thread: LinqJobCardThread,
  messageId: string
) {
  try {
    await thread.setState({ [LINQ_REVIEW_DELIVERED_KEY]: messageId });
  } catch (error) {
    console.warn(
      "[submission-screenshot] could not note the delivered review",
      {
        message: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/** Reads and clears the note, so it answers exactly one turn. */
export async function consumeLinqReviewDelivered(
  thread: LinqJobCardThread
): Promise<string | undefined> {
  try {
    const parsed = threadStateSchema.safeParse(await thread.state);
    if (!parsed.success) return undefined;
    await thread.setState({ [LINQ_REVIEW_DELIVERED_KEY]: null });
    return parsed.data[LINQ_REVIEW_DELIVERED_KEY];
  } catch {
    return undefined;
  }
}
