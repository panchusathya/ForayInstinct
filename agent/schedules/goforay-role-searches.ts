import { defineSchedule } from "eve/schedules";
import {
  channel as linq,
  deliverLinqJobCardsToThread,
} from "@/agent/channels/linq-v2";
import { pollPendingGoforayRoleSearches } from "@/lib/goforay/bridge";

/** Delivers a completed JuiceBox discovery run back to its original text. */
export default defineSchedule({
  cron: "*/2 * * * *",
  async run({ to, waitUntil }) {
    const deliveries = await pollPendingGoforayRoleSearches();
    for (const delivery of deliveries) {
      if (delivery.cards) {
        // Rendered as cards by the channel, with the tapback mapping the
        // cards need. Round-tripped through the model they came out as
        // bullets or not at all, and a thumbs-up on one resolved to nothing.
        waitUntil(
          deliverLinqJobCardsToThread(
            delivery.threadId,
            delivery.cards,
            delivery.scope
          )
        );
        continue;
      }
      if (!delivery.message) continue;
      waitUntil(
        to(linq, { adapterName: "linq", threadId: delivery.threadId }).send(
          delivery.message,
          {
            auth: {
              attributes: { workspaceId: delivery.scope.workspaceId },
              authenticator: "phone-workspace",
              principalId: delivery.scope.userId,
              principalType: "user",
            },
          }
        )
      );
    }
  },
});
