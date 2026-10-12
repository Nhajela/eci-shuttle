import { notImplemented } from "@eci-shuttle/shared";
import type { Job } from "../job";

/**
 * Nightly 02:30 IST (SPEC §2b, §6a): for every workspace, learning.recomputeAll (stats + suggestions), then
 * alerts.sendDigest. One workspace failing must not stop the others (log and continue).
 */
export const learning: Job = {
  name: "learning",
  schedule: "30 2 * * *",
  run: (ctx) => notImplemented(ctx),
};
