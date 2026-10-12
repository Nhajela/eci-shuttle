/**
 * svc-alerts: ops alerts to admins on Telegram (SPEC §6c For admins). Sent through the outbox, so an alert exists
 * iff the change or detection that caused it committed. Per workspace, so test alerts never reach real ops.
 * Event-driven kinds are raised by the service that sees the event, inside its transaction: kill_resume
 * (devices/phones kill, devices/sync resume), update_failed and permission_lost (devices/sync). Watchdog kinds
 * come from alerts/watchdog.
 */
import { type AlertKind, notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { TelegramButton } from "../kernel";

export type AlertEvent = {
  workspaceId: string;
  kind: AlertKind;
  /**
   * Stable per problem episode, so each problem alerts once: e.g. `silent:<vehicleId>:<sinceMs>`,
   * `kill:<deviceId>:<auditId>`. Becomes dedupeKey `alert:<key>:<personId>`.
   */
  key: string;
  /** Telegram HTML, already escaped; times in IST */
  html: string;
  /**
   * The obvious next step (SPEC §6c): bot/callbacks-encoded "Nudge phone" / "Silence 1h" and a URL button
   * "Open in admin" (<origin>/admin/<page>?w=<slug>). Destructive buttons always go through a confirm step.
   */
  buttons?: TelegramButton[][];
};

/**
 * Enqueue the alert (telegram, kind "alert") for every member of the workspace whose prefs (alerts/prefs, defaults
 * when no row) include event.kind and who hasn't blocked the bot; run_after = quietUntil(...) ?? now. Works in the
 * caller's transaction. Returns how many were queued (0 for repeats of the same key).
 */
export async function raiseAlert(db: Db, event: AlertEvent, now: Date): Promise<number> {
  return notImplemented(db, event, now);
}

/**
 * admin_changes: audit rows of the workspace with at in (since, now] made by admin actors, one alert per row to
 * members opted in, never to the row's author (dedupe per audit id). Called by the watchdog job with
 * since = now − 2 min (the dedupe makes overlap harmless).
 */
export async function alertAdminChanges(db: Db, workspaceId: string, since: Date, now: Date): Promise<number> {
  return notImplemented(db, workspaceId, since, now);
}

/**
 * Nightly digest (learning job, after recomputeAll): yesterday's insights in a few lines and the open
 * timetable suggestions, to members opted into "digest". Dedupe `digest:<workspaceId>:<IST date>`.
 */
export async function sendDigest(db: Db, workspaceId: string, now: Date): Promise<number> {
  return notImplemented(db, workspaceId, now);
}
