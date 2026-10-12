import { notImplemented } from "@eci-shuttle/shared";
import type { Job } from "../job";

/**
 * Nightly 03:30 IST (SPEC §2b): delete login codes, pairing codes and proposals expired more than a day ago, and
 * outbox rows sent/dead more than 14 days ago. After the event (PINGS_DELETE_AFTER, an IST date in env; unset =
 * keep) delete raw pings: the phones belong to the drivers (SPEC §4). Deleting expired credentials is
 * bookkeeping, not audited; the ping purge writes one audit row (pings.purge, system actor) with the count.
 */
export const cleanup: Job = {
  name: "cleanup",
  schedule: "30 3 * * *",
  run: (ctx) => notImplemented(ctx),
};
