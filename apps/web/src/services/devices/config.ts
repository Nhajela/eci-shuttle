/** svc-devices: the desired config each phone should run (SPEC §4). */
import { notImplemented, type SyncResponse } from "@eci-shuttle/shared";
import type { Db } from "@/db";

/**
 * The full desired config for one device at `now`: killed/revoked flags; schedule = next 48 h of windows for its
 * assigned vehicle (trackingWindows over service_vehicles ±15 min, plus active_window/force_active directives as
 * active windows and silence_until as idle windows, for the device or its vehicle); intervals from the
 * workspace; OTA target (device override ?? workspace); minAppVersion/apkUrl; apiOrigin = PUBLIC_ORIGIN;
 * serverTime = now. configVersion = devices.config_version. Unassigned phone → no windows (idle).
 */
export async function desiredConfig(db: Db, deviceId: string, now: Date): Promise<SyncResponse> {
  return notImplemented(db, deviceId, now);
}

/**
 * Something that changes phones' configs happened (schedule edit, assignment, directive, kill, workspace
 * settings). In the caller's transaction: config_version + 1 for every affected non-revoked device, and one
 * push job each (outbox, dedupeKey `push:<deviceId>:<newVersion>`). Not audited itself (the caller's mutation
 * is). Returns the device ids bumped.
 */
export async function bumpConfigs(
  db: Db,
  target: { deviceIds?: string[]; vehicleIds?: string[]; workspaceId?: string },
  reason: string,
): Promise<string[]> {
  return notImplemented(db, target, reason);
}
