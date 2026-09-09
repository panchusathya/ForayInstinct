import { z } from "zod";
import type { LinqJobCardThread } from "./linq-job-card-state";
import { normalizeLinqService } from "./linq-service";

/**
 * The transport Linq last reported for this thread: iMessage, SMS, RCS, MMS.
 *
 * A turn learns it from the inbound message and keeps it in eve's channel
 * state. A delivery made outside a turn, such as the poller posting a finished
 * background role search, rebuilds the thread from its id and gets an empty
 * channel state, so it read the transport as unknown and posted every card as
 * text under images the same thread had just received. Same store as the
 * job-card mapping, for the same reason: one place to read and write.
 */
const LINQ_SERVICE_KEY = "linqService";

const threadStateSchema = z.object({ [LINQ_SERVICE_KEY]: z.string() });

export async function rememberLinqThreadService(
  thread: Pick<LinqJobCardThread, "setState">,
  service: string
) {
  try {
    await thread.setState({ [LINQ_SERVICE_KEY]: service });
  } catch (error) {
    console.warn("[goforay] could not note the linq transport", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Empty when the thread has never told us. */
export async function readLinqThreadService(
  thread: Pick<LinqJobCardThread, "state">
) {
  try {
    const parsed = threadStateSchema.safeParse(await thread.state);
    return parsed.success
      ? normalizeLinqService(parsed.data[LINQ_SERVICE_KEY])
      : "";
  } catch {
    return "";
  }
}
