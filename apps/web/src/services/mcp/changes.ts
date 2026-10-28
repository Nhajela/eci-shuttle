/**
 * svc-mcp: change-kind dispatch (SPEC §7a). Each McpChange kind runs through the same service function admin
 * uses, so an AI agent's change and an admin's change are the same code and the same audit rows.
 */
import {
  type Departure,
  expandServiceDepartures,
  formatIst,
  type IsoDate,
  istDate,
  istHHMM,
  istToEpoch,
  type McpChange,
  type McpChangeKind,
  type Role,
  type ServicePattern,
} from "@eci-shuttle/shared";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@/db";
import {
  deviceAssignments,
  devices,
  notices,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  vehicles,
  workspaces,
} from "@/db/schema";
import type { Vehicle, VehicleState } from "@/db/types";
import { adminActor } from "../auth/actor";
import { activeBreaks, breakEnd, endBreak, startBreak } from "../catalog/breaks";
import { createRoute, updateRoute } from "../catalog/routes";
import {
  addException,
  assignServiceVehicle,
  createService,
  unassignServiceVehicle,
  updateService,
} from "../catalog/schedule";
import { archiveSpot, createSpot, updateSpot } from "../catalog/spots";
import { createVehicle, listVehicles, updateVehicle } from "../catalog/vehicles";
import { createWorkspace, setWorkspaceInfo, updateWorkspace } from "../catalog/workspaces";
import { rollbackUpdate, rolloutUpdate, setPhoneUpdate } from "../devices/ota";
import { createPairingCode } from "../devices/pairing";
import {
  assignPhone,
  forceActive,
  isOutsideApp,
  killPhone,
  labelPhone,
  movePhoneToWorkspace,
  nudgePhone,
  resumePhone,
  revokePhone,
  silencePhone,
} from "../devices/phones";
import { vehicleStates } from "../ingest/ingest";
import { type Actor, getInWorkspace, inWorkspace, ServiceError } from "../kernel";
import { createNotice, endNotice } from "../notices/notices";
import { estimateVehicles } from "../public/estimates";

/** Minimum role per change kind (SPEC §7a Roles; matches each service's own requireRole). */
export const CHANGE_ROLE: Record<McpChangeKind, Role> = {
  "spot.create": "ops",
  "spot.update": "ops",
  "spot.archive": "ops",
  "route.create": "ops",
  "route.update": "ops",
  "service.create": "ops",
  "service.update": "ops",
  "service.exception": "ops",
  "service_vehicle.assign": "ops",
  "service_vehicle.unassign": "ops",
  "vehicle.create": "ops",
  "vehicle.update": "ops",
  "vehicle.break": "ops",
  "vehicle.break_end": "ops",
  "phone.label": "ops",
  "phone.assign": "ops",
  "phone.silence": "ops",
  "phone.resume": "ops",
  "phone.force_active": "ops",
  "phone.nudge": "ops",
  "phone.kill": "admin",
  "phone.revoke": "admin",
  "phone.move_workspace": "admin",
  "pairing_code.create": "admin",
  "notice.create": "ops",
  "notice.end": "ops",
  "workspace.create": "admin",
  "workspace.update": "admin",
  "workspace.info": "ops",
  "ota.rollout": "admin",
  "ota.rollback": "admin",
  "ota.phone": "admin",
};

/** Versioned tables a key can name, with the word used in NOT_FOUND messages. */
const VERSIONED = {
  spot: [spots, "spot"],
  route: [routes, "route"],
  service: [services, "service"],
  service_vehicle: [serviceVehicles, "vehicle assignment"],
  vehicle: [vehicles, "vehicle"],
  device: [devices, "phone"],
  notice: [notices, "notice"],
} as const;

/**
 * Pure. The "<entity>:<id>" keys whose versions a change depends on, e.g. spot.update → ["spot:<spotId>"],
 * service.exception / service_vehicle.assign → ["service:<serviceId>"], phone.* / ota.phone → ["device:<deviceId>"].
 * Creates (and pairing_code.create, workspace.create/update, ota.rollout, ota.rollback) → [].
 */
export function versionKeys(change: McpChange): string[] {
  const c = change;
  switch (c.kind) {
    case "spot.update":
    case "spot.archive":
      return [`spot:${c.spotId}`];
    case "route.update":
      return [`route:${c.routeId}`];
    case "service.update":
    case "service.exception":
    case "service_vehicle.assign":
      return [`service:${c.serviceId}`];
    case "service_vehicle.unassign":
      return [`service_vehicle:${c.serviceVehicleId}`];
    case "vehicle.update":
      return [`vehicle:${c.vehicleId}`];
    case "notice.end":
      return [`notice:${c.noticeId}`];
    default:
      return "deviceId" in c ? [`device:${c.deviceId}`] : [];
  }
}

/**
 * Current version of each key, read inside `workspaceId`. A missing or foreign object → NOT_FOUND, an unknown
 * entity → INVALID. `forUpdate` row-locks them (in key order, so two confirms can't deadlock) until the
 * caller's transaction ends.
 */
export async function loadVersions(
  db: Db,
  workspaceId: string,
  keys: string[],
  opts: { forUpdate?: boolean } = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of [...keys].sort()) {
    const at = key.indexOf(":");
    const entry = VERSIONED[key.slice(0, at) as keyof typeof VERSIONED];
    if (!entry) throw new ServiceError("INVALID", `Unknown object "${key}".`, { key });
    const [table, word] = entry;
    out[key] = (await getInWorkspace(db, table, workspaceId, key.slice(at + 1), word, opts)).version;
  }
  return out;
}

// ---------------------------------------------------------------- plain English

const day = (d: IsoDate) => formatIst(istToEpoch(d, "12:00")).split(",")[0];
const when = (iso: string | Date) => formatIst(new Date(iso));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const days = (ds: number[]) => (ds.length === 7 ? "every day" : ds.map((d) => WEEKDAYS[d - 1]).join(", "));
const pattern = (p: ServicePattern) =>
  p.kind === "every" ? `every ${p.everyMin} min` : p.kind === "times" ? `at ${p.times.join(", ")}` : "as a loop";
const CHANNELS = {
  subscribers: "spot subscribers",
  group: "the Telegram group",
  group_pin: "the Telegram group, pinned",
};

/** "name 'X', radius 80 m, clear notes" from the fields a change sets (labels decide which and how). */
function edits(c: object, labels: Record<string, string | ((v: never) => string)>): string {
  return Object.entries(c)
    .filter(([k, v]) => k in labels && v !== undefined)
    .map(([k, v]) => {
      const l = labels[k];
      if (typeof l === "function") return l(v as never);
      return v === null ? `clear ${l}` : `${l} ${typeof v === "string" ? `'${v}'` : String(v)}`;
    })
    .join(", ");
}

const get = <T extends keyof typeof VERSIONED>(db: Db, ws: string, entity: T, id: string) =>
  getInWorkspace(db, VERSIONED[entity][0] as (typeof VERSIONED)[T][0], ws, id, VERSIONED[entity][1]);

async function spotNames(db: Db, ws: string, ids: string[]): Promise<string> {
  const rows = await db
    .select({ id: spots.id, name: spots.name })
    .from(spots)
    .where(and(inWorkspace(spots, ws), inArray(spots.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const missing = ids.find((id) => !byId.has(id));
  if (missing) throw new ServiceError("NOT_FOUND", "No such spot.", { entity: "spot", id: missing });
  return ids.map((id) => byId.get(id)).join(" → ");
}

/** "wait 5 min at each stop, 2 min at Circle, no wait at Riva" for a route's planned waits ("*" = every stop). */
async function waitText(db: Db, ws: string, plan: Record<string, number>): Promise<string> {
  const min = (s: number) => (s === 0 ? "no wait" : `${Math.round(s / 6) / 10} min`);
  // the default first, so "wait" reads once at the start
  const entries = Object.entries(plan).sort(([a], [b]) => Number(b === "*") - Number(a === "*"));
  if (!entries.length) return "no planned wait at stops";
  const parts = await Promise.all(
    entries.map(async ([k, s]) => `${min(s)} at ${k === "*" ? "each stop" : await spotNames(db, ws, [k])}`),
  );
  return parts[0]?.startsWith("no wait") ? parts.join(", ") : `wait ${parts.join(", ")}`;
}

/** The vehicle a phone is in right now (its open assignment), or null. */
async function phoneVehicle(db: Db, deviceId: string): Promise<Vehicle | null> {
  const [row] = await db
    .select({ vehicle: vehicles })
    .from(deviceAssignments)
    .innerJoin(vehicles, eq(vehicles.id, deviceAssignments.vehicleId))
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endsAt)))
    .limit(1);
  return row?.vehicle ?? null;
}

async function workspaceName(db: Db, ws: string): Promise<string> {
  const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ws));
  if (!w) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: ws });
  return w.name;
}

/** "app update 01a13327…": the first 8 characters are enough to tell update ids apart. */
const updateRef = (id: string) => `app update ${id.slice(0, 8)}…`;

async function phone(db: Db, ws: string, deviceId: string) {
  const d = await get(db, ws, "device", deviceId);
  const v = await phoneVehicle(db, deviceId);
  return { name: `phone '${d.label}'`, vehicle: v, full: `phone '${d.label}'${v ? ` (${v.name})` : ""}` };
}

/**
 * One plain-English line for the propose summary, naming objects by name and times in IST, e.g.
 * "Cancel the 10:20 departure of Riva ↔ Circle on Mon 12 Oct" or "Kill phone 'Ravi's Redmi' (Bus 1)".
 * A referenced object that isn't in the workspace → NOT_FOUND.
 */
export async function describeChange(db: Db, workspaceId: string, change: McpChange): Promise<string> {
  const ws = workspaceId;
  const c = change;
  switch (c.kind) {
    case "spot.create":
      return `Add spot '${c.name}' (${c.shortName}) at ${c.lat}, ${c.lng}, radius ${c.radiusM} m`;
    case "spot.update":
      return `Change spot '${(await get(db, ws, "spot", c.spotId)).name}': ${edits(c, {
        name: "name",
        shortName: "short name",
        lat: (v: number) => `latitude ${v}`,
        lng: (v: number) => `longitude ${v}`,
        radiusM: (v: number) => `radius ${v} m`,
        notes: "notes",
        photoUrl: "photo",
      })}`;
    case "spot.archive":
      return `Archive spot '${(await get(db, ws, "spot", c.spotId)).name}'`;
    case "route.create":
      return `Add route '${c.name}': ${await spotNames(db, ws, c.spotIds)}`;
    case "route.update": {
      const r = await get(db, ws, "route", c.routeId);
      const stops = c.spotIds && (await spotNames(db, ws, c.spotIds));
      const waits = c.plannedDwellS && (await waitText(db, ws, c.plannedDwellS));
      return `Change route '${r.name}': ${edits(c, {
        name: "name",
        spotIds: () => `stops ${stops}`,
        path: (v: unknown[]) => `a hand-drawn path (${v.length} points)`,
        regeneratePath: (v: boolean) => (v ? "regenerate the path" : "keep the path"),
        plannedDwellS: () => waits as string,
      })}`;
    }
    case "service.create": {
      const r = await get(db, ws, "route", c.routeId);
      return (
        `Add service '${c.name}' on route '${r.name}': ${days(c.daysOfWeek)} ${c.startTime}–${c.endTime} ` +
        `${pattern(c.pattern)}, ${day(c.validFrom)} to ${day(c.validTo)}${c.public ? "" : " (not public)"}` +
        (c.serviceKind === "special" ? " (special)" : "")
      );
    }
    case "service.update": {
      const s = await get(db, ws, "service", c.serviceId);
      const route = c.routeId && (await get(db, ws, "route", c.routeId)).name;
      return `Change service '${s.name}': ${edits(c, {
        name: "name",
        routeId: () => `route '${route}'`,
        public: (v: boolean) => (v ? "make it public" : "hide it from attendees"),
        colour: "colour",
        validFrom: (v: IsoDate) => `from ${day(v)}`,
        validTo: (v: IsoDate) => `to ${day(v)}`,
        daysOfWeek: (v: number[]) => `runs ${days(v)}`,
        startTime: "start",
        endTime: "end",
        pattern: (v: ServicePattern) => `departs ${pattern(v)}`,
        serviceKind: (v: string) => `make it ${v}`,
      })}`;
    }
    case "service.exception": {
      const s = `'${(await get(db, ws, "service", c.serviceId)).name}'`;
      const on = day(c.date);
      if (c.type === "cancel_day") return `Cancel all of ${s} on ${on}`;
      if (c.type === "cancel_departure") return `Cancel the ${c.departure} departure of ${s} on ${on}`;
      if (c.type === "add_departure") return `Add a ${c.departure} departure to ${s} on ${on}`;
      const m = c.minutes ?? 0;
      return `Move the ${c.departure} departure of ${s} on ${on} ${Math.abs(m)} min ${m < 0 ? "earlier" : "later"}`;
    }
    case "service_vehicle.assign": {
      const s = await get(db, ws, "service", c.serviceId);
      const v = await get(db, ws, "vehicle", c.vehicleId);
      return `Put ${v.name} on '${s.name}' from ${when(c.startsAt)} to ${when(c.endsAt)}`;
    }
    case "service_vehicle.unassign": {
      const sv = await get(db, ws, "service_vehicle", c.serviceVehicleId);
      const s = await get(db, ws, "service", sv.serviceId);
      const v = await get(db, ws, "vehicle", sv.vehicleId);
      return `Take ${v.name} off '${s.name}' (${when(sv.startsAt)} to ${when(sv.endsAt)})`;
    }
    case "vehicle.create":
      return `Add vehicle '${c.name}'${c.plate ? ` (${c.plate})` : ""}${c.capacity ? `, ${c.capacity} seats` : ""}`;
    case "vehicle.update":
      return `Change vehicle '${(await get(db, ws, "vehicle", c.vehicleId)).name}': ${edits(c, {
        name: "name",
        plate: "plate",
        colour: "colour",
        capacity: (v: number | null) => (v === null ? "clear seats" : `${v} seats`),
        active: (v: boolean) => (v ? "back in service" : "out of service"),
      })}`;
    case "vehicle.break": {
      const v = await get(db, ws, "vehicle", c.vehicleId);
      const until = c.minutes === null ? "until ended by hand" : `for ${c.minutes} min`;
      return `${v.name}'s driver is on a break from now ${until}${c.note ? ` (${c.note})` : ""}: no ETA for attendees and no silent or off-route alerts meanwhile`;
    }
    case "vehicle.break_end":
      return `End ${(await get(db, ws, "vehicle", c.vehicleId)).name}'s break now: back in service`;
    case "phone.label":
      return `Rename ${(await phone(db, ws, c.deviceId)).name} to '${c.label}'`;
    case "phone.assign": {
      const p = await phone(db, ws, c.deviceId);
      if (!c.vehicleId) return `Take ${p.name} out of ${p.vehicle?.name ?? "its vehicle"}`;
      return `Put ${p.name} in ${(await get(db, ws, "vehicle", c.vehicleId)).name}`;
    }
    case "phone.silence":
      return `Silence ${(await phone(db, ws, c.deviceId)).full} until ${when(c.until)}`;
    case "phone.resume": {
      const p = await phone(db, ws, c.deviceId);
      const [dev] = await db.select().from(devices).where(eq(devices.id, c.deviceId));
      // a killed Telegram/Traccar phone can't press Resume: this is how it gets back (admin only, checked on apply)
      if (dev?.killedAt && isOutsideApp(dev))
        return `Resume ${p.full} after its kill: it has no app to resume itself, so tracking restarts at its next update (an admin's confirm lifts the kill; ops lifts only its pauses)`;
      return `Lift the pause on ${p.full} now: it tracks again in its shift`;
    }
    case "phone.force_active":
      return `Keep ${(await phone(db, ws, c.deviceId)).full} tracking until ${when(c.until)}${c.intervalS ? `, a fix every ${c.intervalS} s` : ""}`;
    case "phone.nudge":
      return `Ask ${(await phone(db, ws, c.deviceId)).full} to sync now`;
    case "phone.kill":
      return `Kill ${(await phone(db, ws, c.deviceId)).full}`;
    case "phone.revoke":
      return `Revoke ${(await phone(db, ws, c.deviceId)).full}: it has to be paired again`;
    case "phone.move_workspace": {
      const p = await phone(db, ws, c.deviceId);
      const [to] = await db.select().from(workspaces).where(eq(workspaces.id, c.toWorkspaceId));
      if (!to) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: c.toWorkspaceId });
      return `Move ${p.full} to workspace '${to.name}'`;
    }
    case "pairing_code.create":
      return `Make a pairing code for a new phone${c.label ? ` '${c.label}'` : ""}`;
    case "notice.create": {
      const sev = c.severity === "info" ? "" : `${c.severity.replace("_", "-")} `;
      const ch = c.channels.length ? ` (also to ${c.channels.map((x) => CHANNELS[x]).join(", ")})` : "";
      return (
        `Post a ${sev}notice "${c.text}" from ${c.startsAt ? when(c.startsAt) : "now"} ` +
        `until ${c.endsAt ? when(c.endsAt) : "ended by hand"}${ch}`
      );
    }
    case "notice.end":
      return `End notice "${(await get(db, ws, "notice", c.noticeId)).text}"`;
    case "workspace.create":
      return `Create workspace '${c.name}' (${c.slug})`;
    case "workspace.update": {
      const name = await workspaceName(db, ws);
      return c.opsHoursStart && c.opsHoursEnd
        ? `Track the phones in vehicles in ${name} every day ${c.opsHoursStart}–${c.opsHoursEnd} IST (ops hours), not only during services`
        : `Turn off ops hours in ${name}: phones track only during services`;
    }
    case "workspace.info": {
      const name = await workspaceName(db, ws);
      return c.infoMd
        ? `Set the info board on the public page of ${name} to:\n"${c.infoMd}"`
        : `Remove the info board from the public page of ${name}`;
    }
    case "ota.rollout": {
      const name = await workspaceName(db, ws);
      return c.updateId
        ? `Roll out ${updateRef(c.updateId)} to every phone in ${name}`
        : `Stop rolling out app updates in ${name}: phones keep the update they run`;
    }
    case "ota.rollback":
      return `Roll every phone in ${await workspaceName(db, ws)} back to the app update before the last rollout`;
    case "ota.phone": {
      const p = await phone(db, ws, c.deviceId);
      return c.updateId
        ? `Update ${p.full} to ${updateRef(c.updateId)}`
        : `Put ${p.full} back on ${await workspaceName(db, ws)}'s app update`;
    }
  }
}

// ---------------------------------------------------------------- warnings

/** The service a vehicle is running at `now` (its service_vehicles window covers now), or null. */
async function runningNow(db: Db, vehicleId: string, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ name: services.name })
    .from(serviceVehicles)
    .innerJoin(services, eq(services.id, serviceVehicles.serviceId))
    .where(
      and(
        eq(serviceVehicles.vehicleId, vehicleId),
        lte(serviceVehicles.startsAt, now),
        gt(serviceVehicles.endsAt, now),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

/** "Cancelling this leaves Riva without a shuttle 10:00–10:40": departures of every service on the route that day. */
async function gapWarning(
  db: Db,
  ws: string,
  c: Extract<McpChange, { kind: "service.exception" }>,
): Promise<string | null> {
  const svc = await get(db, ws, "service", c.serviceId);
  const route = await get(db, ws, "route", svc.routeId);
  const siblings = await db
    .select()
    .from(services)
    .where(and(inWorkspace(services, ws), eq(services.routeId, route.id), isNull(services.archivedAt)));
  const exs = (
    await db
      .select()
      .from(serviceExceptions)
      .where(
        and(
          inArray(
            serviceExceptions.serviceId,
            siblings.map((s) => s.id),
          ),
          eq(serviceExceptions.date, c.date),
        ),
      )
  ).map((e) => ({ serviceId: e.serviceId, date: e.date, type: e.kind, departure: e.departure, minutes: e.minutes }));
  const all = (extra: typeof exs): Departure[] => siblings.flatMap((s) => expandServiceDepartures(s, extra, c.date));
  const before = all(exs);
  const after = all([...exs, c]);
  const removed = before.filter((d) => !after.some((a) => a.serviceId === d.serviceId && a.at === d.at));
  if (!removed.length) return null;
  const spot = (await get(db, ws, "spot", route.spotIds[0])).name;
  const on = day(c.date);
  if (!after.length) return `Cancelling this leaves ${spot} without a shuttle all day on ${on}.`;
  // Each removed departure falls in the gap between its nearest remaining neighbours (either may be missing).
  const times = [...new Set(after.map((d) => d.at))].sort((a, b) => a - b);
  const gaps = new Set<string>();
  for (const { at } of removed) {
    if (times.includes(at)) continue; // another service still leaves then
    const prev = times.findLast((t) => t < at);
    const next = times.find((t) => t > at);
    if (prev !== undefined && next !== undefined) gaps.add(`${istHHMM(prev)}–${istHHMM(next)}`);
    else if (prev !== undefined) gaps.add(`after ${istHHMM(prev)}`);
    else if (next !== undefined) gaps.add(`until ${istHHMM(next)}`);
  }
  if (!gaps.size) return null;
  return `Cancelling this leaves ${spot} without a shuttle ${[...gaps].join(" and ")} on ${on}.`;
}

const NO_GROUP =
  "This workspace has no Telegram group yet, so nothing is posted to a group. An admin can send /setgroup in the group.";

const OTA_IDLE =
  "Phones download an app update in the background and apply it only while idle, never during a tracking window, so each phone switches at its next idle time.";
const OTA_NATIVE =
  'An update built for a newer native runtime is ignored by phones on an older APK; they show "needs new APK" until the driver installs it.';

const OPS_HOURS_WARNING =
  "Drivers' phones in vehicles will share their location all through these hours, every day, also between services. Outside services the vehicle is off duty: its position shows only to ops (Live board, shuttle_status), never to attendees. A silence on a phone still pauses it.";

/** How many unrevoked phones follow the workspace target, and how many have their own override. */
async function otaReach(db: Db, ws: string): Promise<string> {
  const rows = await db
    .select({ own: devices.targetUpdateId })
    .from(devices)
    .where(and(inWorkspace(devices, ws), isNull(devices.revokedAt)));
  const follow = rows.filter((r) => r.own === null).length;
  const own = rows.length - follow;
  return (
    `${follow} phone${follow === 1 ? " in this workspace follows" : "s in this workspace follow"} the workspace update` +
    `${own ? ` (${own} more ${own === 1 ? "has its" : "have their"} own)` : ""}.`
  );
}

async function oneWarning(db: Db, ws: string, c: McpChange, now: Date): Promise<string | null> {
  switch (c.kind) {
    case "service.exception":
      if (c.date < istDate(now)) return `${day(c.date)} is in the past.`;
      return c.type === "cancel_day" || c.type === "cancel_departure" ? gapWarning(db, ws, c) : null;
    case "notice.create": {
      if (c.endsAt && c.startsAt && new Date(c.endsAt) <= new Date(c.startsAt)) return "Notice ends before it starts.";
      if (c.endsAt && new Date(c.endsAt) <= now) return "Notice ends before now, so nobody will see it.";
      if (c.channels.some((ch) => ch === "group" || ch === "group_pin")) {
        const [w] = await db.select({ group: workspaces.groupChatId }).from(workspaces).where(eq(workspaces.id, ws));
        if (w?.group == null) return NO_GROUP;
      }
      return null;
    }
    case "phone.assign":
    case "phone.silence":
    case "phone.kill":
    case "phone.revoke":
    case "phone.move_workspace": {
      const d = await get(db, ws, "device", c.deviceId);
      const v = await phoneVehicle(db, c.deviceId);
      const svc = v && (await runningNow(db, v.id, now));
      return svc ? `Phone '${d.label}' is in ${v.name}, which is running '${svc}' right now.` : null;
    }
    case "service_vehicle.unassign": {
      const sv = await get(db, ws, "service_vehicle", c.serviceVehicleId);
      if (sv.startsAt > now || sv.endsAt <= now) return null;
      const v = await get(db, ws, "vehicle", sv.vehicleId);
      return `${v.name} is running '${(await get(db, ws, "service", sv.serviceId)).name}' right now.`;
    }
    case "vehicle.update": {
      if (c.active !== false) return null;
      const v = await get(db, ws, "vehicle", c.vehicleId);
      const svc = await runningNow(db, v.id, now);
      return svc ? `${v.name} is running '${svc}' right now.` : null;
    }
    case "ota.rollout":
    case "ota.rollback":
      if (c.kind === "ota.rollout" && !c.updateId) return null;
      return `${OTA_IDLE} ${await otaReach(db, ws)} ${OTA_NATIVE}`;
    case "ota.phone":
      return c.updateId ? `${OTA_IDLE} ${OTA_NATIVE}` : null;
    case "workspace.update":
      return c.opsHoursStart ? OPS_HOURS_WARNING : null;
    default:
      return null;
  }
}

/**
 * Warnings for the whole set at `now`, e.g. "Cancelling this leaves Riva without a shuttle 10:00–10:40",
 * "This phone is in a live vehicle right now", "Notice ends before it starts". Empty when nothing to say.
 */
export async function changeWarnings(db: Db, workspaceId: string, changes: McpChange[], now: Date): Promise<string[]> {
  const out: string[] = [];
  for (const c of changes) {
    const w = await oneWarning(db, workspaceId, c, now);
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------- apply

/** The change's fields as the service's input: drop the discriminator, add the workspace. */
const input = <C extends McpChange>({ kind: _, ...fields }: C, workspaceId: string) => ({ ...fields, workspaceId });

/**
 * Run one change with `actor` (it carries proposalId and reason into the audit row) through its service:
 * spot.* → catalog/spots, route.* → catalog/routes, service.* / service_vehicle.* → catalog/schedule,
 * vehicle.* → catalog/vehicles, phone.* → devices/phones, pairing_code.create → devices/pairing,
 * notice.* → notices, workspace.* → catalog/workspaces, ota.* → devices/ota. Returns the service's result.
 */
export async function applyChange(
  db: Db,
  actor: Actor,
  workspaceId: string,
  change: McpChange,
  now: Date,
): Promise<unknown> {
  const c = change;
  const ws = workspaceId;
  switch (c.kind) {
    case "spot.create":
      return createSpot(db, actor, input(c, ws));
    case "spot.update":
      return updateSpot(db, actor, input(c, ws));
    case "spot.archive":
      return archiveSpot(db, actor, input(c, ws));
    case "route.create":
      return createRoute(db, actor, input(c, ws));
    case "route.update":
      return updateRoute(db, actor, input(c, ws));
    case "service.create": {
      const { serviceKind, ...fields } = input(c, ws);
      return createService(db, actor, { ...fields, kind: serviceKind });
    }
    case "service.update": {
      const { serviceKind, ...fields } = input(c, ws);
      return updateService(db, actor, { ...fields, ...(serviceKind && { kind: serviceKind }) });
    }
    case "service.exception":
      return addException(db, actor, input(c, ws));
    case "service_vehicle.assign":
      return assignServiceVehicle(db, actor, input(c, ws));
    case "service_vehicle.unassign":
      return unassignServiceVehicle(db, actor, input(c, ws));
    case "vehicle.create":
      return createVehicle(db, actor, input(c, ws));
    case "vehicle.update":
      return updateVehicle(db, actor, input(c, ws));
    case "vehicle.break":
      return startBreak(db, actor, input(c, ws), now);
    case "vehicle.break_end":
      return endBreak(db, actor, input(c, ws), now);
    case "phone.label":
      return labelPhone(db, actor, input(c, ws));
    case "phone.assign":
      return assignPhone(db, actor, input(c, ws));
    case "phone.silence":
      return silencePhone(db, actor, input(c, ws));
    case "phone.resume":
      return resumePhone(db, actor, input(c, ws));
    case "phone.force_active":
      return forceActive(db, actor, input(c, ws));
    case "phone.nudge":
      return nudgePhone(db, actor, input(c, ws));
    case "phone.kill":
      return killPhone(db, actor, input(c, ws));
    case "phone.revoke":
      return revokePhone(db, actor, input(c, ws));
    case "phone.move_workspace":
      return movePhoneToWorkspace(db, actor, input(c, ws));
    case "pairing_code.create":
      return createPairingCode(db, actor, input(c, ws), now);
    case "notice.create":
      return createNotice(db, actor, input(c, ws));
    case "notice.end":
      return endNotice(db, actor, input(c, ws));
    case "workspace.create":
      return createWorkspace(db, actor, { slug: c.slug, name: c.name });
    case "workspace.update":
      return updateWorkspace(db, actor, input(c, ws));
    case "workspace.info":
      return setWorkspaceInfo(db, actor, input(c, ws));
    case "ota.rollout":
      return rolloutUpdate(db, actor, input(c, ws));
    case "ota.rollback":
      return rollbackUpdate(db, actor, input(c, ws));
    case "ota.phone":
      return setPhoneUpdate(db, actor, input(c, ws));
  }
}

// ---------------------------------------------------------------- MCP adapter helpers

/** For MCP tools: the person's admin Actor (channel "mcp", with the client name) in a given workspace. */
export const actorFor =
  (ctx: { db: Db; personId: string; client?: string }) =>
  (workspaceId: string): Promise<Actor> =>
    adminActor(ctx.db, { personId: ctx.personId, workspaceId, channel: "mcp", client: ctx.client });

/**
 * `estimate` is set only for a vehicle silent in a leg with no mobile signal (public/sight "predicted"): `state` is
 * its last real fix; the estimated place and arrival are a guess, for ops, never shown to attendees as a fix.
 */
export type LiveBoardRow = {
  vehicle: Vehicle;
  state: VehicleState | null;
  onBreakUntil: string | null;
  estimate?: {
    reason: "no_signal";
    lat: number;
    lng: number;
    alongM: number;
    toSpotId: string;
    lastSeenAt: string;
    /** IST HH:MM it usually gets to toSpotId */
    usuallyArrivesAt: string;
  };
};

/** viewer+. Every vehicle (active first) with its live state, null if it never reported (shuttle_status). */
export async function liveBoard(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<LiveBoardRow[]> {
  // listVehicles checks the viewer role before vehicleStates (which takes no actor) is read
  const list = await listVehicles(db, actor, input);
  const states = await vehicleStates(db, input.workspaceId);
  const breaks = await activeBreaks(db, input.workspaceId, now);
  const guesses = await estimateVehicles(db, input.workspaceId, states, now);
  // an off-duty vehicle keeps a position only inside ops hours (ingest/refreshPhases drop it outside them)
  return list.map((vehicle) => {
    const b = breaks.get(vehicle.id);
    const end = b && breakEnd(b);
    const g = guesses.get(vehicle.id);
    return {
      vehicle,
      state: states.find((x) => x.vehicleId === vehicle.id) ?? null,
      ...(g
        ? {
            estimate: {
              reason: "no_signal" as const,
              lat: g.lat,
              lng: g.lng,
              alongM: g.alongM,
              toSpotId: g.toSpotId,
              lastSeenAt: g.lastSeenAt.toISOString(),
              usuallyArrivesAt: istHHMM(g.arrivesAt.getTime()),
            },
          }
        : {}),
      // driver's break: "13:20" IST, "until ended" when open-ended, null when working
      onBreakUntil: b ? (end ? istHHMM(end) : "until ended") : null,
    };
  });
}
