import { defineSchedule } from "eve/schedules";
import { keepAliveActiveBrowsers } from "@/lib/browser";

export default defineSchedule({
  cron: "*/2 * * * *",
  async run() {
    await keepAliveActiveBrowsers();
  },
});
