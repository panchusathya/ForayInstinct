import { defineSchedule } from "eve/schedules";
import { flushPendingLinqSubmissionScreenshots } from "@/agent/channels/linq-v2";

/** Retries rich application-review media even if no later candidate message arrives. */
export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(flushPendingLinqSubmissionScreenshots());
  },
});
