/** svc-devices: the desired config each phone should run (SPEC §4). */
import {
  OPS_HOURS_LABEL,
  type OpsHours,
  opsHourSpans,
  opsHoursOf,
  type SyncResponse,
  trackingWindows,
  type Window,
} from "@eci-shuttle/shared";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  deviceAssignments,
  devices,
  directives,
  serviceExceptions,
  services,
  serviceVehicles,
  vehicles,
  workspaces,
} from "@/db/schema";
import { origin } from "@/lib/env";
import { enqueue, ServiceError } from "../kernel";

const HORIZON_MS = 48 * 3_600_000;
const LOOKBACK_MS = 24 * 3_600_000;
/**
 * The full desired config for one device at `now`: killed/revoked flags; schedule = next 48 h of windows for its
 * assigned vehicle (trackingWindows over service_vehicles ±15 min, plus active_window/force_active directives as
 * active windows and silence_until as idle windows, for the device or its vehicle, plus the workspace's daily ops
 * tracking hours as active windows labelled OPS_HOURS_LABEL); intervals from the workspace; OTA target (device override ?? workspace); minAppVersion/apkUrl; apiOrigin = PUBLIC_ORIGIN;
 * serverTime = now. configVersion = devices.config_version. Unassigned phone → no windows (idle).
 */
export async function desiredConfig(db: Db, deviceId: string, now: Date): Promise<SyncResponse> {
  const [row] = await db
    .select({ d: devices, ws: workspaces })
    .from(devices)
    .innerJoin(workspaces, eq(workspaces.id, devices.workspaceId))
    .where(eq(devices.id, deviceId));
  if (!row) throw new ServiceError("NOT_FOUND", "Phone not found");
  const { d, ws } = row;

  const [vehicle] = await db
    .select({ id: vehicles.id, name: vehicles.name })
    .from(deviceAssignments)
    .innerJoin(vehicles, eq(vehicles.id, deviceAssignments.vehicleId))
    .where(
      and(
        eq(deviceAssignments.deviceId, d.id),
        lte(deviceAssignments.startsAt, now),
        or(isNull(deviceAssignments.endsAt), gt(deviceAssignments.endsAt, now)),
      ),
    )
    .limit(1);

  const schedule = vehicle ? await windowsFor(db, d.id, vehicle.id, opsHoursOf(ws), now) : [];

  return {
    configVersion: d.configVersion,
    killed: d.killedAt != null,
    revoked: d.revokedAt != null,
    schedule,
    activeIntervalS: ws.activeIntervalS,
    idleHeartbeatS: ws.idleHeartbeatS,
    minAppVersion: ws.minAppVersion,
    apkUrl: ws.apkUrl,
    targetUpdateId: d.targetUpdateId ?? ws.targetUpdateId,
    apiOrigin: origin(),
    serverTime: now.getTime(),
    vehicleName: vehicle?.name ?? null,
    workspace: { slug: ws.slug, isLive: ws.isLive },
  };
}

/** Service windows of the vehicle plus directives on the device or vehicle still open at `now` and starting before now + 48 h, by start. */
async function windowsFor(
  db: Db,
  deviceId: string,
  vehicleId: string,
  opsHours: OpsHours | null,
  now: Date,
): Promise<Window[]> {
  const to = new Date(now.getTime() + HORIZON_MS);

  const svRows = await db
    .select({ sv: serviceVehicles, s: services })
    .from(serviceVehicles)
    .innerJoin(services, eq(services.id, serviceVehicles.serviceId))
    .where(
      and(
        eq(serviceVehicles.vehicleId, vehicleId),
        lt(serviceVehicles.startsAt, to),
        gt(serviceVehicles.endsAt, now),
        isNull(services.archivedAt),
      ),
    );
  const defs = new Map(svRows.map(({ s }) => [s.id, s]));
  const exRows = defs.size
    ? await db
        .select()
        .from(serviceExceptions)
        .where(inArray(serviceExceptions.serviceId, [...defs.keys()]))
    : [];

  const service: Window[] = svRows.length
    ? trackingWindows(
        svRows.map(({ sv }) => ({
          id: sv.id,
          serviceId: sv.serviceId,
          vehicleId: sv.vehicleId,
          startsAt: sv.startsAt.getTime(),
          endsAt: sv.endsAt.getTime(),
        })),
        [...defs.values()].map((s) => ({
          id: s.id,
          kind: s.kind,
          routeId: s.routeId,
          public: s.public,
          validFrom: s.validFrom,
          validTo: s.validTo,
          daysOfWeek: s.daysOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
          pattern: s.pattern,
        })),
        exRows.map((e) => ({
          serviceId: e.serviceId,
          date: e.date,
          type: e.kind,
          departure: e.departure,
          minutes: e.minutes,
        })),
        // look back so a running window keeps its real start (watchdog/phone health measure silence from it)
        now.getTime() - LOOKBACK_MS,
        to.getTime(),
      )
        .filter((w) => w.endsAt > now.getTime())
        .map((w) => ({
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          mode: "active",
          intervalS: null,
          source: "service",
          label: w.serviceIds.map((id) => defs.get(id)?.name ?? "").join(" + ") || null,
        }))
    : [];

  const dirRows = await db
    .select()
    .from(directives)
    .where(
      and(
        or(eq(directives.deviceId, deviceId), eq(directives.vehicleId, vehicleId)),
        isNull(directives.cancelledAt),
        gt(directives.endsAt, now),
        lt(directives.startsAt, to),
      ),
    );
  const overrides: Window[] = dirRows.map((r) => ({
    startsAt: r.startsAt.getTime(),
    endsAt: r.endsAt.getTime(),
    mode: r.kind === "silence_until" ? "idle" : "active",
    intervalS: r.kind === "silence_until" ? null : r.intervalS,
    source: r.kind === "silence_until" ? "silence" : r.kind,
    label: null,
  }));

  // looked back like services, so a running ops window keeps its real start
  const ops: Window[] = opsHourSpans(opsHours, now.getTime() - LOOKBACK_MS, to.getTime())
    .filter((w) => w.endsAt > now.getTime())
    .map((w) => ({ ...w, mode: "active", intervalS: null, source: "active_window", label: OPS_HOURS_LABEL }));

  return [...service, ...ops, ...overrides].sort((a, b) => a.startsAt - b.startsAt);
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
  const match = [
    target.deviceIds?.length ? inArray(devices.id, target.deviceIds) : undefined,
    target.vehicleIds?.length
      ? inArray(
          devices.id,
          db
            .select({ id: deviceAssignments.deviceId })
            .from(deviceAssignments)
            .where(
              and(
                inArray(deviceAssignments.vehicleId, target.vehicleIds),
                or(isNull(deviceAssignments.endsAt), gt(deviceAssignments.endsAt, sql`now()`)),
              ),
            ),
        )
      : undefined,
    target.workspaceId ? eq(devices.workspaceId, target.workspaceId) : undefined,
  ].filter((c) => c !== undefined);
  if (!match.length) return [];

  const bumped = await db
    .update(devices)
    .set({ configVersion: sql`${devices.configVersion} + 1` })
    .where(and(isNull(devices.revokedAt), or(...match)))
    .returning({ id: devices.id, workspaceId: devices.workspaceId, configVersion: devices.configVersion });

  for (const d of bumped)
    await enqueue(db, {
      kind: "push",
      workspaceId: d.workspaceId,
      payload: { deviceId: d.id, reason },
      dedupeKey: `push:${d.id}:${d.configVersion}`,
    });
  return bumped.map((d) => d.id);
}
