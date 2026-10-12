import { runNoticeLifecycle } from "@/services/notices/notices";
import type { Job } from "../job";

/** Every minute (SPEC §2b, §6b): send at start (subscribers, group post + pin), unpin at end. */
export const notices: Job = {
  name: "notices",
  schedule: "* * * * *",
  run: ({ db, now }) => runNoticeLifecycle(db, now),
};
