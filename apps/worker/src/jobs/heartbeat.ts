import { recordHeartbeat } from "@/services/health/health";
import type { Job } from "../job";

/** Every minute: this process's worker_heartbeat row. /api/health fails when the newest is > 3 min old. */
export const heartbeat: Job = {
  name: "heartbeat",
  schedule: "* * * * *",
  // every worker beats for itself
  lock: false,
  run: ({ db, workerId, startedAt, now }) => recordHeartbeat(db, { workerId, startedAt }, now),
};
