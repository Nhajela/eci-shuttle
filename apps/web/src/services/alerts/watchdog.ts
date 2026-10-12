/**
 * svc-alerts: problem detection (SPEC §2b watchdog, §7 Live board flags). The same list feeds the live board,
 * MCP shuttle_initialize ("open problems") and the watchdog alerts.
 */
import { type AlertKind, istDate, istHHMM, istToEpoch, resolveMode } from "@eci-shuttle/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceAssignments, devices, outbox, vehicleState, vehicles, workspaces } from "@/db/schema";
import { encodeCallback } from "@/services/bot/callbacks";
import { desiredConfig } from "@/services/devices/config";
import { refreshPhases } from "@/services/ingest/ingest";
import { adminButton, alertAdminChanges, escapeHtml, raiseAlert } from "./alerts";

/** A vehicle expected active but with no ping for this long is "silent". */
export const SILENT_AFTER_MS = 5 * 60_000;
/** Battery percent (0..100, as phones report it) below which a phone not charging is flagged. */
export const LOW_BATTERY_PCT = 15;
/** Grace for a phone to act on what it was told (kill, new config, a window starting). */
const GRACE_MS = 2 * 60_000;

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
  const t = now.getTime();
  // ponytail: low battery without pings and lost permissions have no start column; the IST day start keeps the
  // alert key stable (one alert per day per phone). Upgrade with devices.*_since columns if that is too noisy.
  const dayStart = new Date(istToEpoch(istDate(t), "00:00"));
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) return [];
  const rows = await db
    .select({ device: devices, vehicle: vehicles, state: vehicleState })
    .from(devices)
    .leftJoin(deviceAssignments, and(eq(deviceAssignments.deviceId, devices.id), isNull(deviceAssignments.endsAt)))
    .leftJoin(vehicles, eq(vehicles.id, deviceAssignments.vehicleId))
    .leftJoin(vehicleState, eq(vehicleState.vehicleId, vehicles.id))
    .where(and(eq(devices.workspaceId, workspaceId), isNull(devices.revokedAt)))
    .orderBy(devices.createdAt);

  const problems: Problem[] = [];
  for (const { device: d, vehicle: v, state: s } of rows) {
    const add = (kind: Problem["kind"], since: Date, message: string, onVehicle = false) =>
      problems.push({
        kind,
        workspaceId,
        vehicleId: v?.id ?? null,
        deviceId: d.id,
        since,
        message: onVehicle ? message : `${d.label}${message}`,
      });

    if (d.killedAt) {
      if (d.reportedMode !== "killed" && t - d.killedAt.getTime() > GRACE_MS)
        add("mode_mismatch", d.killedAt, ` was killed but still reports ${d.reportedMode ?? "nothing"}`);
      continue;
    }

    const desired = resolveMode(await desiredConfig(db, d.id, now), t);
    const windowStart = desired.window ? new Date(desired.window.startsAt) : null;

    if (v && desired.mode === "active" && windowStart) {
      const last = s?.lastPingAt && s.lastPingAt > windowStart ? s.lastPingAt : windowStart;
      if (t - last.getTime() > SILENT_AFTER_MS) add("silent", last, `${v.name} has been silent`, true);
    }
    if (v && s?.offRoute && s.phase !== "off_duty") add("off_route", s.since, `${v.name} is off its route`, true);

    if (d.battery !== null && d.battery < LOW_BATTERY_PCT && d.charging !== true)
      add("low_battery", (await lowSince(db, d.id)) ?? dayStart, ` is at ${Math.round(d.battery)}% battery`);

    const lost = [
      d.permissions && d.permissions.location !== "always" && "location isn't set to 'Allow all the time'",
      d.permissions && !d.permissions.notifications && "notifications are off",
    ].filter(Boolean);
    if (lost.length) add("permission_lost", dayStart, `: ${lost.join(", ")}`);

    const mismatchSince = windowStart ?? dayStart;
    const pushedAt = await pushedAtFor(db, d.id, d.configVersion);
    if (
      d.reportedMode &&
      d.reportedMode !== desired.mode &&
      d.lastSyncAt &&
      d.lastSyncAt.getTime() - mismatchSince.getTime() > GRACE_MS
    )
      add("mode_mismatch", mismatchSince, ` reports ${d.reportedMode} but should be ${desired.mode}`);
    else if (
      d.reportedConfigVersion !== null &&
      d.reportedConfigVersion < d.configVersion &&
      pushedAt &&
      t - pushedAt.getTime() > GRACE_MS
    )
      add("mode_mismatch", pushedAt, " hasn't picked up its new settings");

    const target = d.targetUpdateId ?? ws.targetUpdateId;
    if (d.updateFailedAt && target && d.updateId !== target)
      add("update_failed", d.updateFailedAt, " failed to install the app update");
  }
  return problems;
}

/** Start of the current low-battery episode: the first low ping after the last one at or above the threshold. */
async function lowSince(db: Db, deviceId: string): Promise<Date | null> {
  const rows = await db.execute<{ since: Date | string | null }>(sql`
    select min(recorded_at) as since from pings
    where device_id = ${deviceId} and battery < ${LOW_BATTERY_PCT}
      and recorded_at > coalesce(
        (select max(recorded_at) from pings where device_id = ${deviceId} and battery >= ${LOW_BATTERY_PCT}),
        '-infinity'::timestamptz)`);
  const since = rows[0]?.since;
  return since ? new Date(since) : null;
}

/** When the "sync now" push for this config version was queued (devices/config.bumpConfigs dedupe key). */
async function pushedAtFor(db: Db, deviceId: string, configVersion: number): Promise<Date | null> {
  const [row] = await db
    .select({ at: outbox.createdAt })
    .from(outbox)
    .where(eq(outbox.dedupeKey, `push:${deviceId}:${configVersion}`));
  return row?.at ?? null;
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
  const all = await db.select({ id: workspaces.id }).from(workspaces);
  let problems = 0;
  let alerted = 0;
  for (const { id } of all) {
    await refreshPhases(db, id, now);
    const found = await detectProblems(db, id, now);
    problems += found.length;
    for (const p of found) {
      const buttons = [[await adminButton(db, id, p.vehicleId ? "live" : "phones")]];
      if (p.deviceId)
        buttons.unshift([
          { text: "Nudge phone", callbackData: encodeCallback({ action: "nudge", args: [p.deviceId] }) },
          { text: "Silence 1h", callbackData: encodeCallback({ action: "sil1h", args: [p.deviceId] }) },
        ]);
      alerted += await raiseAlert(
        db,
        {
          workspaceId: id,
          kind: p.kind,
          key: `${p.kind}:${p.vehicleId ?? p.deviceId}:${p.since.getTime()}`,
          html: `<b>${escapeHtml(p.message)}</b>\nSince ${istHHMM(p.since)}`,
          buttons,
        },
        now,
      );
    }
    alerted += await alertAdminChanges(db, id, new Date(now.getTime() - 2 * 60_000), now);
  }
  return { workspaces: all.length, problems, alerted };
}
