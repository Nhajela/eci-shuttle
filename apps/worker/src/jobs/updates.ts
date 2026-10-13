import { runUpdates } from "@/services/subscriptions/updates";
import type { Job } from "../job";

/** Every minute: `/subscribe` updates, each person's at most every 15 min, only while a shuttle runs. */
export const updates: Job = {
  name: "updates",
  schedule: "* * * * *",
  run: ({ db, now }) => runUpdates(db, now),
};
