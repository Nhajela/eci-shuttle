import type { Mode, SyncResponse } from "@eci-shuttle/shared/contracts";

export type OtaInput = {
  targetUpdateId: SyncResponse["targetUpdateId"];
  /** Updates.updateId; null = embedded bundle */
  runningUpdateId: string | null;
  /** id fetched with fetchUpdateAsync but not yet applied */
  downloadedUpdateId: string | null;
  mode: Mode;
};

/** What to do about the server's targetUpdateId right now (SPEC §5). Download any time; reload never while active. */
export function otaStep({ targetUpdateId, runningUpdateId, downloadedUpdateId, mode }: OtaInput) {
  if (!targetUpdateId || targetUpdateId === runningUpdateId) return "none";
  if (downloadedUpdateId !== targetUpdateId) return "download";
  return mode === "active" ? "wait" : "apply";
}
