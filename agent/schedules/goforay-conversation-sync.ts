import { defineSchedule } from "eve/schedules";
import { flushConversationSyncOutbox } from "@/lib/goforay/bridge";

/** Delivers locally persisted candidate messages after a transient bridge outage. */
export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    waitUntil(flushConversationSyncOutbox());
  },
});
