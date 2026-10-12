import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, routes, serviceExceptions, services, serviceVehicles, spots, vehicles } from "@/db/schema";
import type { Actor } from "../kernel";

// bumpConfigs belongs to svc-devices; here we only check we call it with the right vehicles.
const bump = vi.hoisted(() => vi.fn(async () => [] as string[]));
vi.mock("@/services/devices/config", () => ({ bumpConfigs: bump }));

const {
  addException,
  assignServiceVehicle,
  createService,
  duplicateAsSpecial,
  getSchedule,
  removeException,
  unassignServiceVehicle,
  updateService,
} = await import("./schedule");

const db = () => testDb();

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor } = await makeAdmin(db(), ws.id, role);
  const [spot] = await db()
    .insert(spots)
    .values({ workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 })
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({ workspaceId: ws.id, name: "Loop", spotIds: [spot.id, spot.id] })
    .returning();
  const [vehicle] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Van 1" }).returning();
  return { ws, actor, route, vehicle };
}

const base = (workspaceId: string, routeId: string) => ({
  workspaceId,
  name: "Riva ↔ Circle",
  kind: "regular" as const,
  routeId,
  validFrom: "2026-10-12", // Monday
  validTo: "2026-10-31",
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: "08:00",
  endTime: "12:00",
  pattern: { kind: "times" as const, times: ["08:00", "10:20"] },
});

const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId));

beforeEach(() => bump.mockClear());

describe("createService", () => {
  it("creates a service with defaults and audits service.create", async () => {
    const { ws, actor, route } = await setup();
    const s = await createService(db(), actor, base(ws.id, route.id));
    expect(s).toMatchObject({ workspaceId: ws.id, kind: "regular", public: true, version: 1 });
    const [a] = await audits(s.id);
    expect(a).toMatchObject({ action: "service.create", entity: "service", workspaceId: ws.id });
  });

  it("rejects validTo before validFrom (INVALID)", async () => {
    const { ws, actor, route } = await setup();
    await expect(
      createService(db(), actor, { ...base(ws.id, route.id), validFrom: "2026-10-20", validTo: "2026-10-19" }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("refuses a route from another workspace (NOT_FOUND)", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    await expect(createService(db(), actor, base(ws.id, other.route.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("needs ops (viewer → FORBIDDEN)", async () => {
    const { ws, actor, route } = await setup("viewer");
    await expect(createService(db(), actor, base(ws.id, route.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("updateService", () => {
  it("updates fields, bumps version, audits the diff and bumps configs of assigned vehicles", async () => {
    const { ws, actor, route, vehicle } = await setup();
    const s = await createService(db(), actor, base(ws.id, route.id));
    await assignServiceVehicle(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      vehicleId: vehicle.id,
      startsAt: "2026-10-12T00:00:00+05:30",
      endsAt: "2026-11-01T00:00:00+05:30",
    });
    bump.mockClear();
    const u = await updateService(db(), actor, { workspaceId: ws.id, serviceId: s.id, version: 1, endTime: "13:00" });
    expect(u).toMatchObject({ endTime: "13:00", version: 2 });
    const a = (await audits(s.id)).find((r) => r.action === "service.update");
    expect(a?.before).toEqual({ endTime: "12:00", version: 1 });
    expect(a?.after).toEqual({ endTime: "13:00", version: 2 });
    expect(bump).toHaveBeenCalledWith(expect.anything(), { vehicleIds: [vehicle.id] }, expect.any(String));
  });

  it("throws STALE_VERSION on a stale version and writes nothing", async () => {
    const { ws, actor, route } = await setup();
    const s = await createService(db(), actor, base(ws.id, route.id));
    await updateService(db(), actor, { workspaceId: ws.id, serviceId: s.id, name: "A" });
    await expect(
      updateService(db(), actor, { workspaceId: ws.id, serviceId: s.id, version: 1, name: "B" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const [row] = await db().select().from(services).where(eq(services.id, s.id));
    expect(row).toMatchObject({ name: "A", version: 2 });
  });

  it("checks the merged date range (INVALID)", async () => {
    const { ws, actor, route } = await setup();
    const s = await createService(db(), actor, base(ws.id, route.id));
    await expect(
      updateService(db(), actor, { workspaceId: ws.id, serviceId: s.id, validTo: "2026-10-01" }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("can't touch another workspace's service (NOT_FOUND)", async () => {
    const a = await setup();
    const b = await setup();
    const s = await createService(db(), a.actor, base(a.ws.id, a.route.id));
    await expect(
      updateService(db(), b.actor, { workspaceId: b.ws.id, serviceId: s.id, name: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("duplicateAsSpecial", () => {
  it("copies the service as special for the given range, without vehicles", async () => {
    const { ws, actor, route, vehicle } = await setup();
    const s = await createService(db(), actor, base(ws.id, route.id));
    await assignServiceVehicle(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      vehicleId: vehicle.id,
      startsAt: "2026-10-12T00:00:00+05:30",
      endsAt: "2026-10-13T00:00:00+05:30",
    });
    const d = await duplicateAsSpecial(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      name: "Party shuttle",
      validFrom: "2026-10-17",
      validTo: "2026-10-17",
    });
    expect(d).toMatchObject({ kind: "special", name: "Party shuttle", validFrom: "2026-10-17", routeId: route.id });
    expect(d.id).not.toBe(s.id);
    expect(await db().select().from(serviceVehicles).where(eq(serviceVehicles.serviceId, d.id))).toHaveLength(0);
    expect((await audits(d.id))[0]).toMatchObject({ action: "service.duplicate" });
  });
});

describe("exceptions", () => {
  const svc = async () => {
    const ctx = await setup();
    const s = await createService(db(), ctx.actor, base(ctx.ws.id, ctx.route.id));
    return { ...ctx, s };
  };

  it("cancels a planned departure for one day and audits service.exception", async () => {
    const { ws, actor, s } = await svc();
    const e = await addException(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      date: "2026-10-14",
      type: "cancel_departure",
      departure: "10:20",
      note: "fuel",
    });
    expect(e).toMatchObject({ kind: "cancel_departure", departure: "10:20", date: "2026-10-14" });
    expect((await audits(e.id))[0]).toMatchObject({ action: "service.exception", entity: "service_exception" });
  });

  it("rejects a departure that isn't in that day's plan (INVALID)", async () => {
    const { ws, actor, s } = await svc();
    await expect(
      addException(db(), actor, {
        workspaceId: ws.id,
        serviceId: s.id,
        date: "2026-10-14",
        type: "shift_minutes",
        departure: "09:00",
        minutes: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("rejects a date the service doesn't run on (INVALID)", async () => {
    const { ws, actor, s } = await svc();
    await expect(
      addException(db(), actor, { workspaceId: ws.id, serviceId: s.id, date: "2026-11-05", type: "cancel_day" }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("refuses a duplicate (CONFLICT)", async () => {
    const { ws, actor, s } = await svc();
    const input = { workspaceId: ws.id, serviceId: s.id, date: "2026-10-14", type: "cancel_day" as const };
    await addException(db(), actor, input);
    await expect(addException(db(), actor, input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a second cancel_day even when it carries a departure (CONFLICT, not a DB error)", async () => {
    const { ws, actor, s } = await svc();
    const input = { workspaceId: ws.id, serviceId: s.id, date: "2026-10-14", type: "cancel_day" as const };
    await addException(db(), actor, input);
    await expect(addException(db(), actor, { ...input, departure: "08:00" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("accepts cancelling a departure of an every-N-min service", async () => {
    const { ws, actor, route } = await setup();
    const s = await createService(db(), actor, {
      ...base(ws.id, route.id),
      endTime: "09:00",
      pattern: { kind: "every" as const, everyMin: 20 },
    });
    const input = { workspaceId: ws.id, serviceId: s.id, date: "2026-10-14" };
    await addException(db(), actor, { ...input, type: "cancel_departure", departure: "08:20" });
    await expect(
      addException(db(), actor, { ...input, type: "cancel_departure", departure: "08:10" }),
    ).rejects.toMatchObject({ code: "INVALID" });
    const [day] = await getSchedule(db(), actor, { workspaceId: ws.id, from: "2026-10-14", days: 1 });
    expect(day.services[0].departures.map((d) => d.planned)).toEqual(["08:00", "08:40"]);
  });

  it("adds a departure outside the pattern", async () => {
    const { ws, actor, s } = await svc();
    const e = await addException(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      date: "2026-10-14",
      type: "add_departure",
      departure: "13:30",
    });
    expect(e.kind).toBe("add_departure");
  });

  it("removeException deletes it and audits service.exception_remove", async () => {
    const { ws, actor, s, vehicle } = await svc();
    await assignServiceVehicle(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      vehicleId: vehicle.id,
      startsAt: "2026-10-14T00:00:00+05:30",
      endsAt: "2026-10-15T00:00:00+05:30",
    });
    const e = await addException(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      date: "2026-10-14",
      type: "cancel_day",
    });
    bump.mockClear();
    await removeException(db(), actor, { workspaceId: ws.id, exceptionId: e.id });
    expect(await db().select().from(serviceExceptions).where(eq(serviceExceptions.id, e.id))).toHaveLength(0);
    expect((await audits(e.id)).map((r) => r.action)).toContain("service.exception_remove");
    expect(bump).toHaveBeenCalledWith(expect.anything(), { vehicleIds: [vehicle.id] }, expect.any(String));
    await expect(removeException(db(), actor, { workspaceId: ws.id, exceptionId: e.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("service vehicles", () => {
  const svc = async () => {
    const ctx = await setup();
    const s = await createService(db(), ctx.actor, base(ctx.ws.id, ctx.route.id));
    const assign = (startsAt: string, endsAt: string, serviceId = s.id, actor: Actor = ctx.actor) =>
      assignServiceVehicle(db(), actor, {
        workspaceId: ctx.ws.id,
        serviceId,
        vehicleId: ctx.vehicle.id,
        startsAt,
        endsAt,
      });
    return { ...ctx, s, assign };
  };

  it("assigns a vehicle for a time range, audits it and bumps that vehicle's configs", async () => {
    const { vehicle, assign } = await svc();
    const sv = await assign("2026-10-14T08:00:00+05:30", "2026-10-14T12:00:00+05:30");
    expect(sv.startsAt.toISOString()).toBe("2026-10-14T02:30:00.000Z");
    expect((await audits(sv.id))[0]).toMatchObject({ action: "service_vehicle.assign" });
    expect(bump).toHaveBeenCalledWith(expect.anything(), { vehicleIds: [vehicle.id] }, expect.any(String));
  });

  it("rejects endsAt ≤ startsAt (INVALID)", async () => {
    const { assign } = await svc();
    await expect(assign("2026-10-14T12:00:00+05:30", "2026-10-14T08:00:00+05:30")).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("blocks an overlapping assignment of the same vehicle to the same service (CONFLICT)", async () => {
    const { assign } = await svc();
    await assign("2026-10-14T08:00:00+05:30", "2026-10-14T12:00:00+05:30");
    await expect(assign("2026-10-14T11:00:00+05:30", "2026-10-14T13:00:00+05:30")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // touching ranges are fine: [08,12) then [12,14)
    await expect(assign("2026-10-14T12:00:00+05:30", "2026-10-14T14:00:00+05:30")).resolves.toBeTruthy();
  });

  it("allows the same vehicle on another service at the same time (party run)", async () => {
    const { ws, actor, route, assign } = await svc();
    const party = await createService(db(), actor, { ...base(ws.id, route.id), kind: "special", name: "Party" });
    await assign("2026-10-14T08:00:00+05:30", "2026-10-14T12:00:00+05:30");
    await expect(assign("2026-10-14T10:00:00+05:30", "2026-10-14T11:00:00+05:30", party.id)).resolves.toBeTruthy();
  });

  it("unassign removes it, audits and bumps configs", async () => {
    const { ws, actor, vehicle, assign } = await svc();
    const sv = await assign("2026-10-14T08:00:00+05:30", "2026-10-14T12:00:00+05:30");
    bump.mockClear();
    await unassignServiceVehicle(db(), actor, { workspaceId: ws.id, serviceVehicleId: sv.id });
    expect(await db().select().from(serviceVehicles).where(eq(serviceVehicles.id, sv.id))).toHaveLength(0);
    expect((await audits(sv.id)).map((r) => r.action)).toContain("service_vehicle.unassign");
    expect(bump).toHaveBeenCalledWith(expect.anything(), { vehicleIds: [vehicle.id] }, expect.any(String));
  });
});

describe("getSchedule", () => {
  it("returns each day's running services with exceptions, vehicles and departures; viewer can read", async () => {
    const { ws, actor, route, vehicle } = await setup();
    const s = await createService(db(), actor, { ...base(ws.id, route.id), daysOfWeek: [1, 2, 3] });
    const archived = await createService(db(), actor, base(ws.id, route.id));
    await db().update(services).set({ archivedAt: new Date() }).where(eq(services.id, archived.id));
    await addException(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      date: "2026-10-13",
      type: "cancel_departure",
      departure: "10:20",
    });
    await assignServiceVehicle(db(), actor, {
      workspaceId: ws.id,
      serviceId: s.id,
      vehicleId: vehicle.id,
      startsAt: "2026-10-13T07:00:00+05:30",
      endsAt: "2026-10-13T13:00:00+05:30",
    });
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");

    const week = await getSchedule(db(), viewer, { workspaceId: ws.id, from: "2026-10-12", days: 4 });
    expect(week.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(week.map((d) => d.services.length)).toEqual([1, 1, 1, 0]); // Thu isn't in daysOfWeek
    const tue = week[1].services[0];
    expect(tue.service.id).toBe(s.id);
    expect(tue.exceptions).toHaveLength(1);
    expect(tue.vehicles.map((v) => v.vehicleId)).toEqual([vehicle.id]);
    expect(week[0].services[0].vehicles).toHaveLength(0);
    expect(week[0].services[0].departures.map((d) => d.planned)).toEqual(["08:00", "10:20"]);
  });

  it("is workspace-scoped (FORBIDDEN without a membership)", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      getSchedule(db(), b.actor, { workspaceId: a.ws.id, from: "2026-10-12", days: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rows = await db()
      .select()
      .from(services)
      .where(and(eq(services.workspaceId, a.ws.id)));
    expect(rows).toHaveLength(0);
  });
});
