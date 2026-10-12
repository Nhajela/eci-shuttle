import { runWatchdog } from "@/services/alerts/watchdog";
import type { Job } from "../job";

/**
 * Every minute (SPEC §2b): silent / off-route vehicles, low battery, lost permissions, reported ≠ desired,
 * pending kill or update → alerts; vehicles marked offline. All in alerts/watchdog.runWatchdog.
 */
export const watchdog: Job = {
  name: "watchdog",
  schedule: "* * * * *",
  run: ({ db, now }) => runWatchdog(db, now),
};
