import { runPickups } from "@/services/subscriptions/need";
import { runArrivalAlerts } from "@/services/subscriptions/subscriptions";
import type { Job } from "../job";

/**
 * Every 15 s (SPEC §2b): "message me when it's 5 min away" alerts and their expiry, and `/need` requests
 * ("on its way", "here", expiry after 60 min).
 */
export const arrivalAlerts: Job = {
  name: "arrival-alerts",
  schedule: "*/15 * * * * *",
  run: async ({ db, now }) => ({
    arrivals: await runArrivalAlerts(db, {}, now),
    pickups: await runPickups(db, {}, now),
  }),
};
