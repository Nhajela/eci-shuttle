import type { Mode, SyncRequest } from "@eci-shuttle/shared/contracts";
import { otaStep } from "../lib/ota";

/** The slice of expo-updates we use; the real module fits as is. */
export type UpdatesApi = {
  updateId: string | null;
  isEmergencyLaunch: boolean;
  checkForUpdateAsync: () => Promise<{ manifest?: { id: string } }>;
  fetchUpdateAsync: () => Promise<{ manifest?: { id: string } }>;
  reloadAsync: () => Promise<void>;
};

/** Survives the reload: the update id we last reloaded into. */
export type AttemptStore = { get: () => Promise<string | null>; set: (id: string | null) => Promise<void> };

export type OtaResult = "none" | "wait" | "apply" | "mismatch" | "failed" | "error" | "busy";

/** Mismatches (target not servable) on one target before the phone gives up on it and reports updateFailed. */
export const OTA_MAX_TRIES = 3;

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
  // ponytail: in memory, so an app restart gives a given-up target OTA_MAX_TRIES fresh tries
  let tries = { target: null as string | null, n: 0 };
  let emergency = updates.isEmergencyLaunch; // gives up on the first target only; a later one is tried
  let gaveUp: string | null = null; // the target we stopped chasing; reported as updateFailed until it changes
  const miss = (target: string | null, result: OtaResult): OtaResult => {
    if (target === null) return result;
    tries = { target, n: tries.target === target ? tries.n + 1 : 1 };
    if (tries.n < OTA_MAX_TRIES) return result;
    gaveUp = target;
    return "failed";
  };

  return {
    /** Fields for the next SyncRequest. Failed = emergency launch, the update we reloaded into isn't what runs, or we gave up on the target. */
    async report(): Promise<Pick<SyncRequest, "updateId" | "updateFailed">> {
      const attempted = await store.get();
      const failed =
        updates.isEmergencyLaunch || gaveUp !== null || (attempted !== null && attempted !== updates.updateId);
      return failed ? { updateId: updates.updateId, updateFailed: true } : { updateId: updates.updateId };
    },

    /** Call after each sync with its targetUpdateId (and on going idle). Never throws. */
    async reconcile(targetUpdateId: string | null): Promise<OtaResult> {
      if (busy) return "busy";
      busy = true;
      // the server moved on (new target / rollback): fresh tries
      if (gaveUp !== targetUpdateId) gaveUp = null;
      try {
        let attempted = await store.get();
        const hadAttempt = attempted !== null; // the crash that caused an emergency launch was this attempt, already handled below
        // launched fine, or the server moved on (new target / rollback): the attempt no longer matters
        if (attempted !== null && (attempted === updates.updateId || attempted !== targetUpdateId)) {
          await store.set(null);
          attempted = null;
        }
        // expo-updates already fell back from this one; retrying would crash-loop until admin picks another target
        if (targetUpdateId !== null && targetUpdateId === attempted) return "failed";
        if (targetUpdateId !== null && targetUpdateId === gaveUp) return "failed";

        const step = () =>
          otaStep({
            targetUpdateId,
            runningUpdateId: updates.updateId,
            downloadedUpdateId: downloaded,
            // this module tracks the unreachable target itself (`gaveUp`), checked before any fetch
            lastAttemptedTargetId: null,
            mode: getMode(),
          });
        if (step() === "download") {
          // expo-updates fell back to the embedded bundle: chasing the target risks another crash, so wait for a new one
          if (emergency) {
            emergency = false;
            if (!hadAttempt) {
              gaveUp = targetUpdateId;
              return "failed";
            }
          }
          // EAS serves only the channel's latest. Check before fetching: a stored non-target update would launch on the next cold start.
          if ((await updates.checkForUpdateAsync()).manifest?.id !== targetUpdateId) {
            return miss(targetUpdateId, "mismatch");
          }
          downloaded = (await updates.fetchUpdateAsync()).manifest?.id ?? null;
        }
        // ponytail: the channel can still move between check and fetch; then we just don't apply what came down.
        const next = step(); // mode re-read: a window may have opened during the download
        if (next === "download") return miss(targetUpdateId, "mismatch");
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
        // transient (network, store, reload): retried next sync, never counted as a failed update
        return "error";
      } finally {
        busy = false;
      }
    },
  };
}
