import { defineSchedule } from "eve/schedules";
import { channel as linq } from "@/agent/channels/linq-v2";
import { pollPendingGoforayRoleSearches } from "@/lib/goforay/bridge";

/** Delivers a completed JuiceBox discovery run back to its original text. */
export default defineSchedule({
  cron: "*/2 * * * *",
  async run({ to, waitUntil }) {
    const deliveries = await pollPendingGoforayRoleSearches();
    for (const delivery of deliveries) {
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
