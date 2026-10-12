import type { Mode, SyncRequest } from "@eci-shuttle/shared/contracts";
import { otaStep } from "../lib/ota";

/** The slice of expo-updates we use; the real module fits as is. */
export type UpdatesApi = {
  updateId: string | null;
  isEmergencyLaunch: boolean;
  fetchUpdateAsync: () => Promise<{ manifest?: { id: string } }>;
  reloadAsync: () => Promise<void>;
};

/** Survives the reload: the update id we last reloaded into. */
export type AttemptStore = { get: () => Promise<string | null>; set: (id: string | null) => Promise<void> };

export type OtaResult = "none" | "wait" | "apply" | "mismatch" | "failed" | "error" | "busy";

export function createOta({
  updates,
  store,
  getMode,
}: {
  updates: UpdatesApi;
  store: AttemptStore;
  getMode: () => Mode;
}) {
  let downloaded: string | null = null;
  let busy = false;

  return {
    /** Fields for the next SyncRequest. Failed = emergency launch, or the update we reloaded into isn't what runs. */
    async report(): Promise<Pick<SyncRequest, "updateId" | "updateFailed">> {
      const attempted = await store.get();
      const failed = updates.isEmergencyLaunch || (attempted !== null && attempted !== updates.updateId);
      return failed ? { updateId: updates.updateId, updateFailed: true } : { updateId: updates.updateId };
    },

    /** Call after each sync with its targetUpdateId (and on going idle). Never throws. */
    async reconcile(targetUpdateId: string | null): Promise<OtaResult> {
      if (busy) return "busy";
      busy = true;
      try {
        let attempted = await store.get();
        // launched fine, or the server moved on (new target / rollback): the attempt no longer matters
        if (attempted !== null && (attempted === updates.updateId || attempted !== targetUpdateId)) {
          await store.set(null);
          attempted = null;
        }
        // expo-updates already fell back from this one; retrying would crash-loop until admin picks another target
        if (targetUpdateId !== null && targetUpdateId === attempted) return "failed";

        const step = () =>
          otaStep({
            targetUpdateId,
            runningUpdateId: updates.updateId,
            downloadedUpdateId: downloaded,
            mode: getMode(),
          });
        if (step() === "download") {
          downloaded = (await updates.fetchUpdateAsync()).manifest?.id ?? null;
        }
        // ponytail: EAS fetches the channel's latest, not a chosen id; when that isn't the target we don't apply it.
        const next = step(); // mode re-read: a window may have opened during the download
        if (next === "download") return "mismatch";
        if (next === "apply") {
          await store.set(targetUpdateId);
          // a reload that never happened is not a failed launch
          await updates.reloadAsync().catch(async (e) => {
            await store.set(null);
            throw e;
          });
        }
        return next;
      } catch {
        return "error";
      } finally {
        busy = false;
      }
    },
  };
}
