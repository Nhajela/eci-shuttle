import { runArrivalAlerts } from "@/services/subscriptions/subscriptions";
import type { Job } from "../job";

/** Every 15 s (SPEC §2b): the backstop and expiry for "message me when it's 5 min away" (mostly fired on ingest). */
export const arrivalAlerts: Job = {
  name: "arrival-alerts",
  schedule: "*/15 * * * * *",
  run: ({ db, now }) => runArrivalAlerts(db, {}, now),
};
