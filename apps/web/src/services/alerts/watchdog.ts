/**
 * svc-alerts: problem detection (SPEC §2b watchdog, §7 Live board flags). The same list feeds the live board,
 * MCP shuttle_initialize ("open problems") and the watchdog alerts.
 */
import { type AlertKind, istHHMM, resolveMode } from "@eci-shuttle/shared";
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceAssignments, devices, outbox, vehicleState, vehicles, workspaces } from "@/db/schema";
import { escapeHtml } from "@/lib/telegram/html";
import { encodeCallback } from "@/services/bot/callbacks";
import { listAllWorkspaces } from "@/services/catalog/workspaces";
import { desiredConfig } from "@/services/devices/config";
import { refreshPhases } from "@/services/ingest/ingest";
import { adminButton, alertAdminChanges, raiseAlert } from "./alerts";
import { LOW_BATTERY_PCT, SILENT_AFTER_MS } from "./thresholds";

export { LOW_BATTERY_PCT, SILENT_AFTER_MS };

/** Grace for a phone to act on what it was told (kill, new config, a window starting). */
const GRACE_MS = 2 * 60_000;

export type Problem = {
  kind:
    | Extract<AlertKind, "silent" | "off_route" | "low_battery" | "permission_lost" | "mode_mismatch" | "update_failed">
    // ponytail: not an AlertKind yet (frozen contract), so admins opt into it with update_failed (alertKindOf).
    | "update_pending";
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
 * low_battery (< LOW_BATTERY_PCT and not charging, since devices.low_battery_since), permission_lost (location
 * not "always", or notifications off, since devices.permission_lost_since; both since `now` until the watchdog
 * stamps them), mode_mismatch (on its current config, reported mode ≠ what it was told at its last sync while that is
 * still desired, or config version behind, either for longer than two of its sync intervals (at least 2 min) after the
 * mode or config changed), update_failed (update_failed_at after the target was set),
 * update_pending (still not on the target after syncing > 2 min past its push). Killed/revoked phones
 * only show as mode_mismatch while their kill is pending: synced after the kill on its config, still active.
 */
export async function detectProblems(db: Db, workspaceId: string, now: Date): Promise<Problem[]> {
  const t = now.getTime();
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

    // A killed phone stops syncing, so its last report is from before the kill (or the sync that delivered it).
    if (d.killedAt) {
      if (
        d.reportedMode === "active" &&
        d.lastSyncAt &&
        d.lastSyncAt > d.killedAt &&
        d.reportedConfigVersion !== null &&
        d.reportedConfigVersion >= d.configVersion
      )
        add("mode_mismatch", d.killedAt, " was killed but still reports active");
      continue;
    }

    const config = await desiredConfig(db, d.id, now);
    const desired = resolveMode(config, t);
    const windowStart = desired.window ? new Date(desired.window.startsAt) : null;

    if (v && desired.mode === "active" && windowStart) {
      const last = s?.lastPingAt && s.lastPingAt > windowStart ? s.lastPingAt : windowStart;
      if (t - last.getTime() > SILENT_AFTER_MS) add("silent", last, `${v.name} has been silent`, true);
    }
    if (v && s?.offRoute && s.phase !== "off_duty")
      add("off_route", s.offRouteSince ?? s.since, `${v.name} is off its route`, true);

    if (d.battery !== null && d.battery < LOW_BATTERY_PCT && d.charging !== true)
      add("low_battery", d.lowBatterySince ?? now, ` is at ${Math.round(d.battery)}% battery`);

    const lost = [
      d.permissions && d.permissions.location !== "always" && "location isn't set to 'Allow all the time'",
      d.permissions && !d.permissions.notifications && "notifications are off",
    ].filter(Boolean);
    if (lost.length) add("permission_lost", d.permissionLostSince ?? now, `: ${lost.join(", ")}`);

    // When the desired mode began: its window's start, or (idle) the end of the last window; or its config's push, if later.
    // ponytail: the schedule only holds windows still ending in the next 48h, so long idle with no push record isn't judged.
    const lastEnd = Math.max(...(config?.schedule ?? []).map((w) => w.endsAt).filter((e) => e <= t));
    const pushedAt = await pushedAtFor(db, d.id, d.configVersion);
    const mismatchSince = Math.max(windowStart?.getTime() ?? lastEnd, pushedAt?.getTime() ?? Number.NEGATIVE_INFINITY);
    // A phone syncs once per interval of the mode it is in (idle: the heartbeat), so give it two to act on a change.
    const intervalS = d.reportedMode === "active" ? config?.activeIntervalS : config?.idleHeartbeatS;
    const graceMs = Math.max(GRACE_MS, 2_000 * (intervalS ?? 0));
    const applied = d.reportedConfigVersion !== null && d.reportedConfigVersion >= d.configVersion;
    // Judge the report against what the phone was told at its last sync (on its current config), while still desired.
    const told = d.lastSyncAt && resolveMode(config, d.lastSyncAt.getTime()).mode;
    if (
      applied &&
      d.reportedMode &&
      d.lastSyncAt &&
      d.reportedMode !== told &&
      told === desired.mode &&
      Number.isFinite(mismatchSince) &&
      d.lastSyncAt.getTime() - mismatchSince > graceMs
    )
      add("mode_mismatch", new Date(mismatchSince), ` reports ${d.reportedMode} but should be ${desired.mode}`);
    else if (
      d.reportedConfigVersion !== null &&
      d.reportedConfigVersion < d.configVersion &&
      pushedAt &&
      t - pushedAt.getTime() > graceMs
    )
      add("mode_mismatch", pushedAt, " hasn't picked up its new settings");

    const target = d.targetUpdateId ?? ws.targetUpdateId;
    if (d.updateFailedAt && target && d.updateId !== target)
      add("update_failed", d.updateFailedAt, " failed to install the app update");
    // Setting a target bumps configVersion, so its push time is when the phone was told to update.
    else if (
      target &&
      d.updateId !== target &&
      pushedAt &&
      d.reportedConfigVersion !== null &&
      d.reportedConfigVersion >= d.configVersion &&
      d.lastSyncAt &&
      d.lastSyncAt.getTime() - pushedAt.getTime() > GRACE_MS
    )
      add("update_pending", pushedAt, " hasn't installed the app update");
  }
  return problems;
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
 * detectProblems → stampEpisodes (phone episode starts) → alerts.raiseAlert per problem (key `<kind>:<vehicleId|deviceId>:<sinceMs>`), and
 * alerts.alertAdminChanges for the last 2 min.
 */
export async function runWatchdog(
  db: Db,
  now: Date,
): Promise<{ workspaces: number; problems: number; alerted: number }> {
  const all = await listAllWorkspaces(db);
  let problems = 0;
  let alerted = 0;
  for (const { id } of all) {
    // One workspace's bad data must not stop alerts for the others.
    try {
      await refreshPhases(db, id, now);
      const found = await detectProblems(db, id, now);
      problems += found.length;
      await stampEpisodes(db, id, found, now);
      alerted += await alertProblems(db, id, found, now);
      alerted += await alertAdminChanges(db, id, new Date(now.getTime() - 2 * 60_000), now);
    } catch (e) {
      console.error(`watchdog: workspace ${id} failed`, e);
    }
  }
  return { workspaces: all.length, problems, alerted };
}

/**
 * Starts (now) or ends (null) each phone's low-battery / lost-permission episode, so its alert key stays put.
 * Derived bookkeeping like vehicle_state: not audited, and updated_at is left alone.
 */
async function stampEpisodes(db: Db, workspaceId: string, found: Problem[], now: Date): Promise<void> {
  const cols = [
    ["low_battery", "lowBatterySince"],
    ["permission_lost", "permissionLostSince"],
  ] as const;
  for (const [kind, key] of cols) {
    const col = devices[key];
    const ids = found.flatMap((p) => (p.kind === kind && p.deviceId ? [p.deviceId] : []));
    if (ids.length)
      await db
        .update(devices)
        .set({ [key]: now, updatedAt: devices.updatedAt })
        .where(and(inArray(devices.id, ids), isNull(col)));
    await db
      .update(devices)
      .set({ [key]: null, updatedAt: devices.updatedAt })
      .where(
        and(eq(devices.workspaceId, workspaceId), isNotNull(col), ids.length ? notInArray(devices.id, ids) : undefined),
      );
  }
}

/** The admin pref that gates a problem (update_pending has no AlertKind of its own yet). */
const alertKindOf = (k: Problem["kind"]): AlertKind => (k === "update_pending" ? "update_failed" : k);

async function alertProblems(db: Db, id: string, found: Problem[], now: Date): Promise<number> {
  let alerted = 0;
  for (const p of found) {
    const buttons = [[await adminButton(db, id, p.vehicleId ? "live" : "phones")]];
    if (p.deviceId)
      buttons.unshift([
        { text: "Nudge phone", callbackData: encodeCallback({ action: "nudge", args: [p.deviceId] }) },
        { text: "Silence 1h", callbackData: encodeCallback({ action: "sil1h", args: [p.deviceId] }) },
      ]);
    // Vehicle problems follow the vehicle; phone problems follow the phone, so a swapped-in phone alerts afresh.
    const subject = p.kind === "silent" || p.kind === "off_route" ? p.vehicleId : p.deviceId;
    alerted += await raiseAlert(
      db,
      {
        workspaceId: id,
        kind: alertKindOf(p.kind),
        key: `${p.kind}:${subject}:${p.since.getTime()}`,
        html: `<b>${escapeHtml(p.message)}</b>\nSince ${istHHMM(p.since)}`,
        buttons,
      },
      now,
    );
  }
  return alerted;
}
