import { sendDigest } from "@/services/alerts/alerts";
import { listAllWorkspaces } from "@/services/catalog/workspaces";
import { recomputeAll } from "@/services/learning/learning";
import type { Job, JobContext } from "../job";

/**
 * Nightly 02:30 IST (SPEC §2b, §6a): for every workspace, learning.recomputeAll (stats + suggestions), then
 * alerts.sendDigest. One workspace failing must not stop the others (log and continue).
 */
export async function runLearning(ctx: JobContext, svc = { recomputeAll, sendDigest }): Promise<{ failed: number }> {
  const { db, now, log } = ctx;
  const all = await listAllWorkspaces(db);
  let failed = 0;
  for (const w of all) {
    // separate tries: the digest (yesterday's insights) is still worth sending when recompute fails
    for (const step of [svc.recomputeAll, svc.sendDigest]) {
      try {
        await step(db, w.id, now);
      } catch (e) {
        failed++;
        log(`${w.slug}: ${step.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { failed };
}

export const learning: Job = {
  name: "learning",
  schedule: "30 2 * * *",
  run: (ctx) => runLearning(ctx),
};
