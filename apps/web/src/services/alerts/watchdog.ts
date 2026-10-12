/**
 * svc-alerts: problem detection (SPEC §2b watchdog, §7 Live board flags). The same list feeds the live board,
 * MCP shuttle_initialize ("open problems") and the watchdog alerts.
 */
import { type AlertKind, notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";

/** A vehicle expected active but with no ping for this long is "silent". */
export const SILENT_AFTER_MS = 5 * 60_000;
/** Battery percent (0..100, as phones report it) below which a phone not charging is flagged. */
export const LOW_BATTERY_PCT = 15;

export type Problem = {
  kind: Extract<
    AlertKind,
    "silent" | "off_route" | "low_battery" | "permission_lost" | "mode_mismatch" | "update_failed"
  >;
  workspaceId: string;
  vehicleId: string | null;
  deviceId: string | null;
  /** when the problem started (episode start: also the alert key) */
  since: Date;
  /** plain English, no time in it: "Bus 1 has been silent", "Ravi's phone is at 12% battery" */
  message: string;
};

/**
 * Open problems of a workspace at `now` (no actor: callers check access):
 * silent (inside its tracking window, last ping > SILENT_AFTER_MS ago), off_route (vehicle_state.off_route),
 * low_battery (< LOW_BATTERY_PCT and not charging), permission_lost (location not "always", or notifications
 * off), mode_mismatch (reported mode ≠ resolveMode on the desired config, or reported config version behind for
 * > 2 min after a push), update_failed (update_failed_at after the target was set). Killed/revoked phones
 * only show as mode_mismatch while their kill is pending.
 */
export async function detectProblems(db: Db, workspaceId: string, now: Date): Promise<Problem[]> {
  return notImplemented(db, workspaceId, now);
}

/**
 * The watchdog job (every minute), for every workspace: ingest.refreshPhases (marks vehicles offline/off duty),
 * detectProblems → alerts.raiseAlert per problem (key `<kind>:<vehicleId|deviceId>:<sinceMs>`), and
 * alerts.alertAdminChanges for the last 2 min.
 */
export async function runWatchdog(
  db: Db,
  now: Date,
): Promise<{ workspaces: number; problems: number; alerted: number }> {
  return notImplemented(db, now);
}
