import { env } from "@/lib/env";
import { runCleanup } from "@/services/cleanup/cleanup";
import type { Job } from "../job";

/** Nightly 03:30 IST (SPEC §2b): expired codes/proposals, old outbox, raw pings after PINGS_DELETE_AFTER. */
export const cleanup: Job = {
  name: "cleanup",
  schedule: "30 3 * * *",
  run: async ({ db, now, log }) => {
    const counts = await runCleanup(db, env.pingsDeleteAfter(), now);
    log(`deleted ${JSON.stringify(counts)}`);
    return counts;
  },
};
