import type { Mode, SyncResponse } from "@eci-shuttle/shared/contracts";

export type OtaInput = {
  targetUpdateId: SyncResponse["targetUpdateId"];
  /** Updates.updateId; null = embedded bundle */
  runningUpdateId: string | null;
  /** id fetched with fetchUpdateAsync but not yet applied */
  downloadedUpdateId: string | null;
  /** target that was current when the last fetchUpdateAsync finished; null = never fetched */
  lastAttemptedTargetId: string | null;
  mode: Mode;
};

/**
 * What to do about the server's targetUpdateId right now (SPEC §5). Download any time; reload never while active.
 *
 * fetchUpdateAsync can't fetch a chosen id: it gets the newest compatible update on the phone's channel.
 * When a finished fetch for this target gave another id, stop (no 15s download loop) and send
 * updateFailed: true in the next sync. For svc-ota, a rollback must republish the old update
 * (`eas update:republish`) so it is the newest on the channel; pointing the target at an older id can't be fetched.
 */
export function otaStep({
  targetUpdateId,
  runningUpdateId,
  downloadedUpdateId,
  lastAttemptedTargetId,
  mode,
}: OtaInput) {
  if (!targetUpdateId || targetUpdateId === runningUpdateId) return "none";
  if (downloadedUpdateId !== targetUpdateId) return lastAttemptedTargetId === targetUpdateId ? "none" : "download";
  return mode === "active" ? "wait" : "apply";
}
