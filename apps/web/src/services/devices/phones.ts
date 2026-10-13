/**
 * svc-devices: admin control of phones (SPEC §7 Phones, §4 directives). Every change that alters what a phone
 * should do bumps its config (config.bumpConfigs → configVersion+1 and a push). Roles: label, assign, silence,
 * force active, nudge = ops+; kill, revoke, move workspace = admin.
 */
import {
  type DirectiveKind,
  Id,
  IST_TZ,
  istHHMM,
  type Permissions,
  PhoneAssignFields,
  PhoneForceActiveFields,
  PhoneKillFields,
  PhoneLabelFields,
  PhoneMoveWorkspaceFields,
  PhoneNudgeFields,
  PhoneRevokeFields,
  PhoneSilenceFields,
  resolveMode,
  type SyncResponse,
  withWorkspace,
} from "@eci-shuttle/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { deviceAssignments, devices, directives, memberships, outbox, vehicles, workspaces } from "@/db/schema";
import type { Device, DeviceAssignment, Directive, Vehicle } from "@/db/types";
import { escapeHtml } from "@/lib/telegram/html";
import { adminButton, raiseAlert } from "../alerts/alerts";
import { SILENT_AFTER_MS } from "../alerts/watchdog";
import {
  type Actor,
  can,
  enqueue,
  getInWorkspace,
  inWorkspace,
  mutate,
  parseInput,
  readable,
  requireRole,
  ServiceError,
} from "../kernel";
import { bumpConfigs, desiredConfig } from "./config";

export const LabelPhoneInput = withWorkspace(PhoneLabelFields);
export const AssignPhoneInput = withWorkspace(PhoneAssignFields);
export const SilencePhoneInput = withWorkspace(PhoneSilenceFields);
export const ForceActiveInput = withWorkspace(PhoneForceActiveFields);
export const NudgePhoneInput = withWorkspace(PhoneNudgeFields);
export const KillPhoneInput = withWorkspace(PhoneKillFields);
export const RevokePhoneInput = withWorkspace(PhoneRevokeFields);
export const MovePhoneInput = withWorkspace(PhoneMoveWorkspaceFields);

/** Row version + updated_at for any admin edit of a device. */
const edited = () => ({ version: sql`${devices.version} + 1`, updatedAt: new Date() });

/** The phone, locked when in a transaction. Revoked phones can only be listed (re-pair instead). */
async function livePhone(db: Db, workspaceId: string, deviceId: string, forUpdate = false): Promise<Device> {
  const d = await getInWorkspace(db, devices, workspaceId, deviceId, "phone", { forUpdate });
  if (d.revokedAt) throw new ServiceError("INVALID", "This phone is revoked. Pair it again to use it.", { deviceId });
  return d;
}

/** Closes the open assignments matching `where` at `now`; returns the closed rows. */
const closeAssignments = (tx: Db, where: SQL, now: Date) =>
  tx
    .update(deviceAssignments)
    .set({ endsAt: now })
    .where(and(where, isNull(deviceAssignments.endsAt)))
    .returning();

const openAssignment = async (db: Db, deviceId: string): Promise<DeviceAssignment | null> =>
  (
    await db
      .select()
      .from(deviceAssignments)
      .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endsAt)))
  )[0] ?? null;

export async function labelPhone(db: Db, actor: Actor, input: z.input<typeof LabelPhoneInput>): Promise<Device> {
  const { workspaceId, deviceId, label } = parseInput(LabelPhoneInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "phone.label", entity: "device", entityId: deviceId, workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, devices, workspaceId, deviceId, "phone", { forUpdate: true });
    const [after] = await tx
      .update(devices)
      .set({ label, ...edited() })
      .where(eq(devices.id, deviceId))
      .returning();
    return { before, after, result: after };
  });
}

/** Closes the open assignment (ends_at = now) and opens one for vehicleId (null = just unassign). A vehicle
 *  holding another phone loses it (that phone's assignment closes too). Bumps both phones' configs. */
export async function assignPhone(
  db: Db,
  actor: Actor,
  input: z.input<typeof AssignPhoneInput>,
): Promise<DeviceAssignment | null> {
  const { workspaceId, deviceId, vehicleId } = parseInput(AssignPhoneInput, input);
  requireRole(actor, workspaceId, "ops");
  await livePhone(db, workspaceId, deviceId);
  const open = await openAssignment(db, deviceId);
  if ((open?.vehicleId ?? null) === vehicleId) return open; // already so: write nothing

  return mutate(
    db,
    actor,
    { action: "phone.assign", entity: "device", entityId: deviceId, workspaceId },
    async (tx) => {
      await livePhone(tx, workspaceId, deviceId, true);
      if (vehicleId) await getInWorkspace(tx, vehicles, workspaceId, vehicleId, "vehicle", { forUpdate: true });
      const now = new Date();
      const closed = await closeAssignments(tx, eq(deviceAssignments.deviceId, deviceId), now);
      let created: DeviceAssignment | null = null;
      let displaced: string[] = [];
      if (vehicleId) {
        displaced = (await closeAssignments(tx, eq(deviceAssignments.vehicleId, vehicleId), now)).map(
          (a) => a.deviceId,
        );
        [created] = await tx
          .insert(deviceAssignments)
          .values({ workspaceId, deviceId, vehicleId, startsAt: now })
          .returning();
      }
      await bumpConfigs(tx, { deviceIds: [deviceId, ...displaced] }, "phone.assign");
      return {
        before: { vehicleId: closed[0]?.vehicleId ?? null },
        after: { vehicleId, ...(displaced.length ? { displacedDeviceIds: displaced } : {}) },
        result: created,
      };
    },
  );
}

async function addDirective(
  db: Db,
  actor: Actor,
  workspaceId: string,
  deviceId: string,
  kind: DirectiveKind,
  until: string,
  intervalS: number | null,
): Promise<Directive> {
  const endsAt = new Date(until);
  const action = kind === "silence_until" ? "phone.silence" : "phone.force_active";
  return mutate(db, actor, { action, entity: "directive", workspaceId }, async (tx) => {
    await livePhone(tx, workspaceId, deviceId, true);
    const startsAt = new Date();
    if (endsAt <= startsAt) throw new ServiceError("INVALID", "Pick a time in the future.", { until });
    const open = (k: DirectiveKind) =>
      and(eq(directives.kind, k), isNull(directives.cancelledAt), gt(directives.endsAt, startsAt));
    if (kind === "force_active") {
      // silence beats active (resolveMode), so a vehicle-wide silence would make this force do nothing
      const vehicleId = (await openAssignment(tx, deviceId))?.vehicleId;
      const [vs] = vehicleId
        ? await tx
            .select()
            .from(directives)
            .where(and(eq(directives.vehicleId, vehicleId), open("silence_until"), lt(directives.startsAt, endsAt)))
            .orderBy(desc(directives.endsAt))
            .limit(1)
        : [];
      if (vs) {
        const hhmm = vs.endsAt.toLocaleTimeString("en-GB", { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit" });
        throw new ServiceError("INVALID", `This vehicle is silenced until ${hhmm} IST. Cancel that first.`, {
          directiveId: vs.id,
        });
      }
    }
    // the newest instruction wins: end the phone's open opposite directive
    const cancelled = await tx
      .update(directives)
      .set({ cancelledAt: startsAt, version: sql`${directives.version} + 1` })
      .where(and(eq(directives.deviceId, deviceId), open(kind === "force_active" ? "silence_until" : "force_active")))
      .returning({ id: directives.id });
    const [d] = await tx
      .insert(directives)
      .values({ workspaceId, deviceId, kind, startsAt, endsAt, intervalS })
      .returning();
    await bumpConfigs(tx, { deviceIds: [deviceId] }, action);
    const after = cancelled.length ? { ...d, cancelledDirectiveIds: cancelled.map((c) => c.id) } : d;
    return { before: null, after, result: d };
  });
}

/** A silence_until directive [now, until): idle even inside windows. */
export async function silencePhone(db: Db, actor: Actor, input: z.input<typeof SilencePhoneInput>): Promise<Directive> {
  const { workspaceId, deviceId, until } = parseInput(SilencePhoneInput, input);
  requireRole(actor, workspaceId, "ops");
  return addDirective(db, actor, workspaceId, deviceId, "silence_until", until, null);
}

/** A force_active directive [now, until) with optional intervalS. */
export async function forceActive(db: Db, actor: Actor, input: z.input<typeof ForceActiveInput>): Promise<Directive> {
  const { workspaceId, deviceId, until, intervalS } = parseInput(ForceActiveInput, input);
  requireRole(actor, workspaceId, "ops");
  return addDirective(db, actor, workspaceId, deviceId, "force_active", until, intervalS);
}

/** Cancel a silence/force directive early. Already cancelled or ended: nothing to do. */
export async function cancelDirective(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; directiveId: string },
): Promise<void> {
  const { workspaceId, directiveId } = input;
  requireRole(actor, workspaceId, "ops");
  const d = await getInWorkspace(db, directives, workspaceId, directiveId, "directive");
  if (d.cancelledAt || d.endsAt <= new Date()) return;
  await mutate(db, actor, { action: "directive.cancel", entity: "directive", workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, directives, workspaceId, directiveId, "directive", { forUpdate: true });
    const [after] = await tx
      .update(directives)
      .set({ cancelledAt: new Date(), version: sql`${directives.version} + 1` })
      .where(eq(directives.id, directiveId))
      .returning();
    // the check constraint guarantees exactly one target
    const target = before.deviceId ? { deviceIds: [before.deviceId] } : { vehicleIds: [before.vehicleId as string] };
    await bumpConfigs(tx, target, "directive.cancel");
    return { before, after, result: undefined };
  });
}

/** Push "sync now" without changing config (queues a push; audited phone.nudge). */
export async function nudgePhone(db: Db, actor: Actor, input: z.input<typeof NudgePhoneInput>): Promise<void> {
  const { workspaceId, deviceId } = parseInput(NudgePhoneInput, input);
  requireRole(actor, workspaceId, "ops");
  await mutate(db, actor, { action: "phone.nudge", entity: "device", entityId: deviceId, workspaceId }, async (tx) => {
    await livePhone(tx, workspaceId, deviceId);
    await enqueue(tx, { kind: "push", payload: { deviceId, reason: "nudge" }, workspaceId });
    return { before: null, after: null, result: undefined };
  });
}

/**
 * The kill_resume ops alert (SPEC §6c) in the caller's transaction; prefs and quiet hours apply via raiseAlert.
 * Keyed on the kill time, so each kill and its resume alert once.
 */
export async function alertKillResume(
  tx: Db,
  phone: Device,
  event: "killed" | "resumed",
  killedAt: Date,
  now: Date,
): Promise<void> {
  await raiseAlert(
    tx,
    {
      workspaceId: phone.workspaceId,
      kind: "kill_resume",
      key: `${event}:${phone.id}:${killedAt.getTime()}`,
      html: `<b>Phone '${escapeHtml(phone.label)}' ${event}</b> at ${istHHMM(now)}`,
      buttons: [[await adminButton(tx, phone.workspaceId, "phones")]],
    },
    now,
  );
}

/** admin. Sets killed_at; the phone latches killed on next sync. Only the driver's Resume clears it. */
export async function killPhone(db: Db, actor: Actor, input: z.input<typeof KillPhoneInput>): Promise<Device> {
  const { workspaceId, deviceId } = parseInput(KillPhoneInput, input);
  requireRole(actor, workspaceId, "admin");
  const phone = await livePhone(db, workspaceId, deviceId);
  if (phone.killedAt) return phone;
  return mutate(db, actor, { action: "phone.kill", entity: "device", entityId: deviceId, workspaceId }, async (tx) => {
    const before = await livePhone(tx, workspaceId, deviceId, true);
    const now = new Date();
    await tx
      .update(devices)
      .set({ killedAt: now, ...edited() })
      .where(eq(devices.id, deviceId));
    await bumpConfigs(tx, { deviceIds: [deviceId] }, "phone.kill");
    const after = await getInWorkspace(tx, devices, workspaceId, deviceId, "phone");
    await alertKillResume(tx, after, "killed", now, now);
    return { before, after, result: after };
  });
}

/** admin. Sets revoked_at, closes assignments; the token stops working after the next sync tells it so. */
export async function revokePhone(db: Db, actor: Actor, input: z.input<typeof RevokePhoneInput>): Promise<Device> {
  const { workspaceId, deviceId } = parseInput(RevokePhoneInput, input);
  requireRole(actor, workspaceId, "admin");
  const phone = await getInWorkspace(db, devices, workspaceId, deviceId, "phone");
  if (phone.revokedAt) return phone;
  return mutate(
    db,
    actor,
    { action: "phone.revoke", entity: "device", entityId: deviceId, workspaceId },
    async (tx) => {
      const before = await livePhone(tx, workspaceId, deviceId, true);
      const now = new Date();
      await closeAssignments(tx, eq(deviceAssignments.deviceId, deviceId), now);
      // bump before revoking: bumpConfigs skips revoked devices, and the phone must sync once more to learn it
      await bumpConfigs(tx, { deviceIds: [deviceId] }, "phone.revoke");
      const [after] = await tx
        .update(devices)
        .set({ revokedAt: now, ...edited() })
        .where(eq(devices.id, deviceId))
        .returning();
      return { before, after, result: after };
    },
  );
}

/**
 * admin in BOTH workspaces (the second membership is looked up in the DB). Clears assignments and directives,
 * moves the device (and nothing else), bumps config. A simulated device can't move into the live workspace
 * (INVALID).
 */
export async function movePhoneToWorkspace(
  db: Db,
  actor: Actor,
  input: z.input<typeof MovePhoneInput>,
): Promise<Device> {
  const { workspaceId, deviceId, toWorkspaceId } = parseInput(MovePhoneInput, input);
  requireRole(actor, workspaceId, "admin");
  if (toWorkspaceId === workspaceId) throw new ServiceError("INVALID", "The phone is already in this workspace.");
  if (actor.kind !== "system") {
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.personId, actor.id), eq(memberships.workspaceId, toWorkspaceId)));
    if (m?.role !== "admin")
      throw new ServiceError("FORBIDDEN", "You need the admin role in the workspace you're moving the phone to.", {
        workspaceId: toWorkspaceId,
      });
  }
  const [to] = await db.select().from(workspaces).where(eq(workspaces.id, toWorkspaceId));
  if (!to) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: toWorkspaceId });

  return mutate(
    db,
    actor,
    { action: "phone.move_workspace", entity: "device", entityId: deviceId, workspaceId },
    async (tx) => {
      const before = await livePhone(tx, workspaceId, deviceId, true);
      if (before.simulated && to.isLive)
        throw new ServiceError("INVALID", "A simulated phone can't join the live workspace.", { deviceId });
      const now = new Date();
      await closeAssignments(tx, eq(deviceAssignments.deviceId, deviceId), now);
      await tx
        .update(directives)
        .set({ cancelledAt: now, version: sql`${directives.version} + 1` })
        .where(and(eq(directives.deviceId, deviceId), isNull(directives.cancelledAt), gt(directives.endsAt, now)));
      await tx
        .update(devices)
        // drop the per-phone OTA pin: a test update must not follow the phone into live (SPEC §5)
        .set({ workspaceId: toWorkspaceId, targetUpdateId: null, ...edited() })
        .where(eq(devices.id, deviceId));
      await bumpConfigs(tx, { deviceIds: [deviceId] }, "phone.move_workspace");
      const after = await getInWorkspace(tx, devices, toWorkspaceId, deviceId, "phone");
      return { before, after, result: after };
    },
  );
}

export type PhoneHealth = {
  device: Device;
  vehicle: Vehicle | null;
  /** desired mode right now (resolveMode on the desired config) vs device.reportedMode */
  desiredMode: string;
  modeMismatch: boolean;
  /** assigned, should be active, and not heard from for alerts' SILENT_AFTER_MS (since the window opened) */
  silent: boolean;
  configBehind: boolean;
  lastSyncAgoS: number | null;
  needsNewApk: boolean;
  updateFailed: boolean;
  permissionsOk: boolean;
  permissions: Permissions | null;
  activeDirectives: Directive[];
};

/** Dotted-number compare, so "1.10.0" is not below "1.4.0". */
export function versionBelow(v: string, min: string): boolean {
  const a = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

// ponytail: mirrors alerts/watchdog's mode_mismatch rule (it exports no helper and isn't ours to edit);
// the watchdog should import isModeMismatch so the two can't drift.
const GRACE_MS = 2 * 60_000;

/** When the "sync now" push for the phone's current config version was queued (config.bumpConfigs dedupe key). */
async function pushedAt(db: Db, d: Device): Promise<Date | null> {
  const [row] = await db
    .select({ at: outbox.createdAt })
    .from(outbox)
    .where(eq(outbox.dedupeKey, `push:${d.id}:${d.configVersion}`));
  return row?.at ?? null;
}

/**
 * The watchdog's reports-the-wrong-mode rule. Killed: synced after the kill on its config and still reports active.
 * Otherwise: on its current config, reported mode ≠ what it was told at its last sync while that is still desired,
 * for longer than two of its sync intervals (at least 2 min) after the mode or config changed.
 */
export function isModeMismatch(d: Device, config: SyncResponse, pushed: Date | null, now: Date): boolean {
  const applied = d.reportedConfigVersion !== null && d.reportedConfigVersion >= d.configVersion;
  if (d.killedAt) return d.reportedMode === "active" && !!d.lastSyncAt && d.lastSyncAt > d.killedAt && applied;
  if (!applied || !d.reportedMode || !d.lastSyncAt) return false;
  const t = now.getTime();
  const desired = resolveMode(config, t);
  const told = resolveMode(config, d.lastSyncAt.getTime()).mode;
  const lastEnd = Math.max(...(config.schedule ?? []).map((w) => w.endsAt).filter((e) => e <= t));
  const since = Math.max(desired.window?.startsAt ?? lastEnd, pushed?.getTime() ?? Number.NEGATIVE_INFINITY);
  const intervalS = d.reportedMode === "active" ? config.activeIntervalS : config.idleHeartbeatS;
  const graceMs = Math.max(GRACE_MS, 2_000 * (intervalS ?? 0));
  return (
    d.reportedMode !== told &&
    told === desired.mode &&
    Number.isFinite(since) &&
    d.lastSyncAt.getTime() - since > graceMs
  );
}

const permissionsOk = (p: Permissions | null) =>
  !!p && p.location === "always" && p.preciseLocation && p.notifications && p.batteryOptimizationExempt;

/** viewer+. The Phones page and MCP shuttle_phones. Revoked phones last. */
export async function listPhones(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<PhoneHealth[]> {
  const { workspaceId } = input;
  readable(actor, workspaceId);
  const phones = await db.select().from(devices).where(inWorkspace(devices, workspaceId)).orderBy(asc(devices.label));
  return healthOf(db, workspaceId, phones, now);
}

/** viewer+, any workspace the actor reads (bot callbacks only carry the id); others' phones are NOT_FOUND. */
export async function getPhone(db: Db, actor: Actor, input: { deviceId: string }, now: Date): Promise<PhoneHealth> {
  const { deviceId } = parseInput(z.object({ deviceId: Id }), input);
  const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
  // A phone the actor can't read is "missing", so ids from other workspaces don't leak (CONTRACTS: NOT_FOUND).
  if (!d || !can(actor, d.workspaceId, "viewer"))
    throw new ServiceError("NOT_FOUND", "No such phone.", { entity: "phone", id: deviceId });
  return (await healthOf(db, d.workspaceId, [d], now))[0];
}

/** viewer+. The phone currently assigned to the vehicle (Live board, Vehicles page), or null. */
export async function getVehiclePhone(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; vehicleId: string },
  now: Date,
): Promise<PhoneHealth | null> {
  const { workspaceId, vehicleId } = input;
  readable(actor, workspaceId);
  await getInWorkspace(db, vehicles, workspaceId, vehicleId, "vehicle");
  const [row] = await db
    .select({ device: devices })
    .from(deviceAssignments)
    .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
    .where(and(eq(deviceAssignments.vehicleId, vehicleId), isNull(deviceAssignments.endsAt)));
  return row ? (await healthOf(db, workspaceId, [row.device], now))[0] : null;
}

/** No actor (worker jobs): the workspace's phones assigned to a vehicle, revoked ones left out. */
export async function trackedDevices(db: Db, workspaceId: string): Promise<{ deviceId: string; vehicleId: string }[]> {
  return db
    .select({ deviceId: deviceAssignments.deviceId, vehicleId: deviceAssignments.vehicleId })
    .from(deviceAssignments)
    .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
    .where(
      and(inWorkspace(deviceAssignments, workspaceId), isNull(deviceAssignments.endsAt), isNull(devices.revokedAt)),
    )
    .orderBy(asc(devices.label));
}

async function healthOf(db: Db, workspaceId: string, phones: Device[], now: Date): Promise<PhoneHealth[]> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: workspaceId });
  if (!phones.length) return [];
  const assigned = await db
    .select({ deviceId: deviceAssignments.deviceId, vehicle: vehicles })
    .from(deviceAssignments)
    .innerJoin(vehicles, eq(vehicles.id, deviceAssignments.vehicleId))
    .where(
      and(
        inWorkspace(deviceAssignments, workspaceId),
        isNull(deviceAssignments.endsAt),
        inArray(
          deviceAssignments.deviceId,
          phones.map((p) => p.id),
        ),
      ),
    );
  const vehicleOf = new Map(assigned.map((a) => [a.deviceId, a.vehicle]));
  const vehicleIds = assigned.map((a) => a.vehicle.id);
  // not cancelled and not yet over (includes ones that start later)
  const dirs = await db
    .select()
    .from(directives)
    .where(
      and(
        inWorkspace(directives, workspaceId),
        isNull(directives.cancelledAt),
        gt(directives.endsAt, now),
        or(
          inArray(
            directives.deviceId,
            phones.map((p) => p.id),
          ),
          vehicleIds.length ? inArray(directives.vehicleId, vehicleIds) : sql`false`,
        ),
      ),
    )
    .orderBy(asc(directives.startsAt));

  const out: PhoneHealth[] = [];
  for (const device of phones) {
    const vehicle = vehicleOf.get(device.id) ?? null;
    const revoked = !!device.revokedAt;
    // ponytail: one desiredConfig per phone (N queries); fine for a handful of phones
    const config = revoked ? null : await desiredConfig(db, device.id, now);
    const desired = config ? resolveMode(config, now.getTime()) : null;
    const desiredMode = desired?.mode ?? "revoked";
    // same rule as the watchdog's silent alert, with the phone's last sync for the vehicle's last ping
    const heardAt = Math.max(device.lastSyncAt?.getTime() ?? 0, desired?.window?.startsAt ?? 0);
    out.push({
      device,
      vehicle,
      desiredMode,
      silent: !!vehicle && desiredMode === "active" && now.getTime() - heardAt > SILENT_AFTER_MS,
      modeMismatch: !!config && isModeMismatch(device, config, await pushedAt(db, device), now),
      configBehind: !revoked && (device.reportedConfigVersion ?? 0) < device.configVersion,
      lastSyncAgoS: device.lastSyncAt ? Math.floor((now.getTime() - device.lastSyncAt.getTime()) / 1000) : null,
      needsNewApk: !!(ws.minAppVersion && device.appVersion && versionBelow(device.appVersion, ws.minAppVersion)),
      updateFailed: !!device.updateFailedAt,
      permissionsOk: permissionsOk(device.permissions),
      permissions: device.permissions,
      activeDirectives: dirs.filter((d) => d.deviceId === device.id || (vehicle && d.vehicleId === vehicle.id)),
    });
  }
  return out.sort((a, b) => Number(!!a.device.revokedAt) - Number(!!b.device.revokedAt));
}
