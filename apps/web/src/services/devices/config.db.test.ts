import { randomUUID } from "node:crypto";
import { OPS_HOURS_LABEL, resolveMode, SyncResponse, trackingWindows, type VehicleWindow } from "@eci-shuttle/shared";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deviceAssignments,
  devices,
  directives,
  outbox,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  vehicles,
} from "@/db/schema";
import { bumpConfigs, desiredConfig } from "./config";

// trackingWindows is shared-schedule's (tested there); here we check what config feeds it and does with its output.
vi.mock("@eci-shuttle/shared", async (orig) => ({
  ...(await orig<typeof import("@eci-shuttle/shared")>()),
  trackingWindows: vi.fn(() => []),
}));
const tw = vi.mocked(trackingWindows);

const db = () => testDb();
const NOW = new Date("2026-10-15T04:00:00Z"); // 09:30 IST
const H = 3_600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H);

async function makeDevice(workspaceId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db()
    .insert(devices)
    .values({ workspaceId, label: "Phone", tokenHash: randomUUID(), ...over })
    .returning();
  return d;
}
async function makeVehicle(workspaceId: string, name = "Bus 1") {
  const [v] = await db().insert(vehicles).values({ workspaceId, name }).returning();
  return v;
}
const assign = (workspaceId: string, deviceId: string, vehicleId: string, startsAt = at(-24), endsAt?: Date) =>
  db().insert(deviceAssignments).values({ workspaceId, deviceId, vehicleId, startsAt, endsAt });

async function makeService(workspaceId: string, over: Partial<typeof services.$inferInsert> = {}) {
  const [r] = await db().insert(routes).values({ workspaceId, name: "Loop", spotIds: [] }).returning();
  const [s] = await db()
    .insert(services)
    .values({
      workspaceId,
      name: "Riva ↔ Circle",
      kind: "regular",
      routeId: r.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "20:00",
      pattern: { kind: "every", everyMin: 30 },
      ...over,
    })
    .returning();
  return s;
}

beforeEach(() => {
  tw.mockReset();
  tw.mockReturnValue([]);
});

describe("desiredConfig", () => {
  it("unassigned phone: workspace defaults, no windows, origin, server time; valid SyncResponse", async () => {
    const ws = await makeWorkspace(db(), {
      activeIntervalS: 7,
      idleHeartbeatS: 600,
      minAppVersion: "1.2.0",
      apkUrl: "https://x.test/app.apk",
      targetUpdateId: "upd-ws",
    });
    const d = await makeDevice(ws.id);
    const c = await desiredConfig(db(), d.id, NOW);
    expect(SyncResponse.parse(c)).toEqual(c);
    expect(c).toEqual({
      configVersion: 1,
      killed: false,
      revoked: false,
      schedule: [],
      activeIntervalS: 7,
      idleHeartbeatS: 600,
      minAppVersion: "1.2.0",
      apkUrl: "https://x.test/app.apk",
      targetUpdateId: "upd-ws",
      apiOrigin: "http://localhost:3000",
      serverTime: NOW.getTime(),
      vehicleName: null,
      workspace: { slug: ws.slug, isLive: false },
    });
    expect(tw).not.toHaveBeenCalled();
  });

  it("device OTA override beats the workspace; killed/revoked flags; configVersion from the row", async () => {
    const ws = await makeWorkspace(db(), { targetUpdateId: "upd-ws" });
    const d = await makeDevice(ws.id, {
      targetUpdateId: "upd-dev",
      killedAt: at(-1),
      revokedAt: at(-1),
      configVersion: 9,
    });
    const c = await desiredConfig(db(), d.id, NOW);
    expect(c).toMatchObject({ targetUpdateId: "upd-dev", killed: true, revoked: true, configVersion: 9 });
  });

  it("unknown device → NOT_FOUND", async () => {
    await expect(desiredConfig(db(), randomUUID(), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("assigned phone: feeds trackingWindows its vehicle's next 48 h, maps windows to active service windows", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(ws.id);
    const v = await makeVehicle(ws.id);
    const other = await makeVehicle(ws.id, "Bus 2");
    await assign(ws.id, d.id, v.id);
    const s = await makeService(ws.id);
    const archived = await makeService(ws.id, { name: "Old", archivedAt: at(-48) });
    const sv = { workspaceId: ws.id, serviceId: s.id };
    const [mine] = await db()
      .insert(serviceVehicles)
      .values({ ...sv, vehicleId: v.id, startsAt: at(-2), endsAt: at(10) })
      .returning();
    await db()
      .insert(serviceVehicles)
      .values([
        { ...sv, vehicleId: v.id, startsAt: at(-10), endsAt: at(-1) }, // ended
        { ...sv, vehicleId: v.id, startsAt: at(49), endsAt: at(60) }, // beyond 48 h
        { ...sv, vehicleId: other.id, startsAt: at(-2), endsAt: at(10) }, // other vehicle
        { workspaceId: ws.id, serviceId: archived.id, vehicleId: v.id, startsAt: at(-2), endsAt: at(10) },
      ]);
    await db()
      .insert(serviceExceptions)
      .values({ workspaceId: ws.id, serviceId: s.id, date: "2026-10-16", kind: "cancel_day" });
    const win: VehicleWindow = {
      vehicleId: v.id,
      startsAt: at(1).getTime(),
      endsAt: at(5).getTime(),
      serviceIds: [s.id],
    };
    tw.mockReturnValue([win]);

    const c = await desiredConfig(db(), d.id, NOW);

    expect(tw).toHaveBeenCalledTimes(1);
    const [svs, defs, exs, from, to] = tw.mock.calls[0];
    expect(svs).toEqual([
      { id: mine.id, serviceId: s.id, vehicleId: v.id, startsAt: at(-2).getTime(), endsAt: at(10).getTime() },
    ]);
    expect(defs).toEqual([
      {
        id: s.id,
        kind: "regular",
        routeId: s.routeId,
        public: true,
        validFrom: "2026-10-11",
        validTo: "2026-11-01",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "08:00",
        endTime: "20:00",
        pattern: { kind: "every", everyMin: 30 },
      },
    ]);
    expect(exs).toEqual([{ serviceId: s.id, date: "2026-10-16", type: "cancel_day", departure: null, minutes: null }]);
    expect([from, to]).toEqual([at(-24).getTime(), at(48).getTime()]);
    expect(c.vehicleName).toBe("Bus 1");
    expect(c.schedule).toEqual([
      {
        startsAt: win.startsAt,
        endsAt: win.endsAt,
        mode: "active",
        intervalS: null,
        source: "service",
        label: "Riva ↔ Circle",
      },
    ]);
  });

  it("ended assignment → unassigned", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(ws.id);
    const v = await makeVehicle(ws.id);
    await assign(ws.id, d.id, v.id, at(-5), at(-1));
    const c = await desiredConfig(db(), d.id, NOW);
    expect(c.vehicleName).toBeNull();
    expect(tw).not.toHaveBeenCalled();
  });

  it("directives on the device or its vehicle become windows; cancelled, past, far and others' are left out", async () => {
    const ws = await makeWorkspace(db());
    const d = await makeDevice(ws.id);
    const d2 = await makeDevice(ws.id);
    const v = await makeVehicle(ws.id);
    await assign(ws.id, d.id, v.id);
    const base = { workspaceId: ws.id };
    await db()
      .insert(directives)
      .values([
        { ...base, deviceId: d.id, kind: "force_active", startsAt: at(-1), endsAt: at(1), intervalS: 5 },
        { ...base, vehicleId: v.id, kind: "active_window", startsAt: at(2), endsAt: at(3) },
        { ...base, vehicleId: v.id, kind: "silence_until", startsAt: at(0), endsAt: at(4) },
        { ...base, deviceId: d.id, kind: "active_window", startsAt: at(5), endsAt: at(6), cancelledAt: at(-1) },
        { ...base, deviceId: d.id, kind: "active_window", startsAt: at(-5), endsAt: at(-4) },
        { ...base, deviceId: d.id, kind: "active_window", startsAt: at(50), endsAt: at(51) },
        { ...base, deviceId: d2.id, kind: "active_window", startsAt: at(1), endsAt: at(2) },
      ]);
    const c = await desiredConfig(db(), d.id, NOW);
    expect(c.schedule).toEqual([
      {
        startsAt: at(-1).getTime(),
        endsAt: at(1).getTime(),
        mode: "active",
        intervalS: 5,
        source: "force_active",
        label: null,
      },
      {
        startsAt: at(0).getTime(),
        endsAt: at(4).getTime(),
        mode: "idle",
        intervalS: null,
        source: "silence",
        label: null,
      },
      {
        startsAt: at(2).getTime(),
        endsAt: at(3).getTime(),
        mode: "active",
        intervalS: null,
        source: "active_window",
        label: null,
      },
    ]);
  });

  it("ops hours add a daily active window for an assigned phone only; silence and kill still win", async () => {
    const ws = await makeWorkspace(db(), { opsHoursStart: "09:00", opsHoursEnd: "21:00" });
    const d = await makeDevice(ws.id);
    const loose = await makeDevice(ws.id);
    const v = await makeVehicle(ws.id);
    await assign(ws.id, d.id, v.id);
    const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
    const ops = (from: number, to: number) => ({
      startsAt: from,
      endsAt: to,
      mode: "active",
      intervalS: null,
      source: "active_window",
      label: OPS_HOURS_LABEL,
    });
    const c = await desiredConfig(db(), d.id, NOW);
    expect(c.schedule).toEqual([
      ops(ist("2026-10-15", "09:00"), ist("2026-10-15", "21:00")),
      ops(ist("2026-10-16", "09:00"), ist("2026-10-16", "21:00")),
      ops(ist("2026-10-17", "09:00"), NOW.getTime() + 48 * H),
    ]);
    expect(resolveMode(c, NOW.getTime()).mode).toBe("active");
    expect((await desiredConfig(db(), loose.id, NOW)).schedule).toEqual([]);

    await db()
      .insert(directives)
      .values({ workspaceId: ws.id, deviceId: d.id, kind: "silence_until", startsAt: at(-1), endsAt: at(1) });
    expect(resolveMode(await desiredConfig(db(), d.id, NOW), NOW.getTime()).mode).toBe("idle");
    await db().update(devices).set({ killedAt: NOW }).where(eq(devices.id, d.id));
    expect(resolveMode(await desiredConfig(db(), d.id, at(2)), at(2).getTime()).mode).toBe("killed");
  });
});

describe("bumpConfigs", () => {
  const pushes = (deviceId: string) =>
    db()
      .select()
      .from(outbox)
      .then((rows) => rows.filter((r) => (r.payload as { deviceId?: string }).deviceId === deviceId));

  it("bumps by device, by vehicle (current assignment) and by workspace, skips revoked, queues one push each", async () => {
    const ws = await makeWorkspace(db());
    const a = await makeDevice(ws.id);
    const b = await makeDevice(ws.id);
    const c = await makeDevice(ws.id);
    const revoked = await makeDevice(ws.id, { revokedAt: at(-1) });
    const v = await makeVehicle(ws.id);
    await assign(ws.id, b.id, v.id);
    // ended (bumpConfigs has no `now`, it uses the DB clock): not affected by the vehicle
    await assign(ws.id, c.id, v.id, new Date(Date.now() - 10 * H), new Date(Date.now() - H));

    const byIds = await bumpConfigs(db(), { deviceIds: [a.id, revoked.id], vehicleIds: [v.id] }, "kill");
    expect(byIds.sort()).toEqual([a.id, b.id].sort());
    const [row] = await db().select().from(devices).where(eq(devices.id, a.id));
    expect(row.configVersion).toBe(2);
    expect(row.version).toBe(1); // the admin edit version is untouched
    const [job] = await pushes(a.id);
    expect(job).toMatchObject({
      kind: "push",
      workspaceId: ws.id,
      dedupeKey: `push:${a.id}:2`,
      payload: { deviceId: a.id, reason: "kill" },
    });

    const all = await bumpConfigs(db(), { workspaceId: ws.id }, "intervals");
    expect(all.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await pushes(a.id)).toHaveLength(2);
    expect(await pushes(revoked.id)).toHaveLength(0);
    const [r2] = await db().select().from(devices).where(eq(devices.id, revoked.id));
    expect(r2.configVersion).toBe(1);
  });

  it("empty target → nothing", async () => {
    expect(await bumpConfigs(db(), {}, "x")).toEqual([]);
    expect(await bumpConfigs(db(), { deviceIds: [], vehicleIds: [] }, "x")).toEqual([]);
  });
});
