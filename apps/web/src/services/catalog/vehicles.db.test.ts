import { makeSpot, makeTrip, makeVehicle } from "@tests/factories/admin-vehicles";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/db/schema";
import { bumpConfigs } from "@/services/devices/config";
import { createVehicle, listVehicles, listVehicleTrips, updateVehicle } from "./vehicles";

// bumpConfigs belongs to svc-devices; here we only check vehicles calls it with the right target.
vi.mock("@/services/devices/config", () => ({ bumpConfigs: vi.fn(async () => []) }));

const db = () => testDb();
const auditFor = (entityId: string) =>
  db().select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor } = await makeAdmin(db(), ws.id, role);
  return { ws, actor };
}

beforeEach(() => vi.mocked(bumpConfigs).mockClear());

describe("createVehicle", () => {
  it("creates with defaults and audits vehicle.create", async () => {
    const { ws, actor } = await setup();
    const v = await createVehicle(db(), actor, { workspaceId: ws.id, name: "  Bus 1 ", plate: "GA-07-1234" });
    expect(v).toMatchObject({ workspaceId: ws.id, name: "Bus 1", plate: "GA-07-1234", colour: null, active: true });
    const rows = await auditFor(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "vehicle.create", entity: "vehicle", workspaceId: ws.id, before: null });
    expect(rows[0].after).toMatchObject({ name: "Bus 1" });
  });

  it("rejects invalid input and viewers", async () => {
    const { ws, actor } = await setup();
    await expect(createVehicle(db(), actor, { workspaceId: ws.id, name: "" })).rejects.toMatchObject({
      code: "INVALID",
    });
    const viewer = await makeAdmin(db(), ws.id, "viewer");
    await expect(createVehicle(db(), viewer.actor, { workspaceId: ws.id, name: "X" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("updateVehicle", () => {
  it("updates given fields, bumps version, audits only the diff", async () => {
    const { ws, actor } = await setup();
    const v = await createVehicle(db(), actor, { workspaceId: ws.id, name: "Bus 1", capacity: 12 });
    const u = await updateVehicle(db(), actor, { workspaceId: ws.id, vehicleId: v.id, version: 1, capacity: 14 });
    expect(u).toMatchObject({ name: "Bus 1", capacity: 14, version: 2 });
    const [, row] = await auditFor(v.id);
    expect(row).toMatchObject({ action: "vehicle.update", before: { capacity: 12, version: 1 } });
    expect(row.after).toEqual({ capacity: 14, version: 2 });
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("STALE_VERSION on a stale version, NOT_FOUND across workspaces", async () => {
    const { ws, actor } = await setup();
    const v = await createVehicle(db(), actor, { workspaceId: ws.id, name: "Bus 1" });
    await updateVehicle(db(), actor, { workspaceId: ws.id, vehicleId: v.id, name: "Bus A" });
    await expect(
      updateVehicle(db(), actor, { workspaceId: ws.id, vehicleId: v.id, version: 1, name: "Bus B" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const other = await setup();
    await expect(
      updateVehicle(db(), other.actor, { workspaceId: other.ws.id, vehicleId: v.id, name: "Mine" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deactivating bumps its phones' configs inside the mutation", async () => {
    const { ws, actor } = await setup();
    const v = await createVehicle(db(), actor, { workspaceId: ws.id, name: "Bus 1" });
    const u = await updateVehicle(db(), actor, { workspaceId: ws.id, vehicleId: v.id, active: false });
    expect(u.active).toBe(false);
    expect(bumpConfigs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ vehicleIds: [v.id] });
  });
});

describe("listVehicles", () => {
  it("active first, then by name; only this workspace; viewer can read", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    await createVehicle(db(), other.actor, { workspaceId: other.ws.id, name: "Elsewhere" });
    await createVehicle(db(), actor, { workspaceId: ws.id, name: "Aardvark", active: false });
    await createVehicle(db(), actor, { workspaceId: ws.id, name: "Zed" });
    await createVehicle(db(), actor, { workspaceId: ws.id, name: "Bus" });
    const viewer = await makeAdmin(db(), ws.id, "viewer");
    const list = await listVehicles(db(), viewer.actor, { workspaceId: ws.id });
    expect(list.map((v) => v.name)).toEqual(["Bus", "Zed", "Aardvark"]);
    await expect(listVehicles(db(), viewer.actor, { workspaceId: other.ws.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("listVehicleTrips", () => {
  const now = new Date("2026-10-12T06:00:00Z");
  const ago = (h: number) => new Date(+now - h * 3_600_000);

  it("returns this workspace's trips since the cutoff, newest first, with spot names", async () => {
    const { ws, actor } = await setup("viewer");
    const v = await makeVehicle(db(), ws.id);
    const riva = await makeSpot(db(), ws.id, "Riva");
    const circle = await makeSpot(db(), ws.id, "Circle");
    const base = { workspaceId: ws.id, vehicleId: v.id };
    await makeTrip(db(), {
      ...base,
      fromSpotId: riva.id,
      toSpotId: circle.id,
      departedAt: ago(2),
      arrivedAt: ago(1.5),
      durationS: 1800,
    });
    await makeTrip(db(), { ...base, fromSpotId: circle.id, departedAt: ago(1) });
    await makeTrip(db(), { ...base, fromSpotId: riva.id, departedAt: ago(24 * 8) });
    const other = await makeWorkspace(db());
    const ov = await makeVehicle(db(), other.id);
    const os = await makeSpot(db(), other.id, "Elsewhere");
    await makeTrip(db(), { workspaceId: other.id, vehicleId: ov.id, fromSpotId: os.id, departedAt: ago(1) });

    const rows = await listVehicleTrips(db(), actor, { workspaceId: ws.id, since: ago(24 * 7), perVehicle: 20 });
    expect(rows.map((r) => [r.fromName, r.toName])).toEqual([
      ["Circle", null],
      ["Riva", "Circle"],
    ]);
    expect(rows[1]).toMatchObject({ vehicleId: v.id, durationS: 1800, quality: "clean", total: 2 });
  });

  it("caps rows per vehicle, not per workspace, and still counts every trip", async () => {
    const { ws, actor } = await setup("viewer");
    const busy = await makeVehicle(db(), ws.id, { name: "Busy" });
    const quiet = await makeVehicle(db(), ws.id, { name: "Quiet" });
    const riva = await makeSpot(db(), ws.id, "Riva");
    // busy's 5 trips are all newer than quiet's 3: a workspace-wide cap of 4 would starve quiet
    for (let i = 0; i < 5; i++)
      await makeTrip(db(), { workspaceId: ws.id, vehicleId: busy.id, fromSpotId: riva.id, departedAt: ago(1 + i) });
    for (let i = 0; i < 3; i++)
      await makeTrip(db(), { workspaceId: ws.id, vehicleId: quiet.id, fromSpotId: riva.id, departedAt: ago(10 + i) });

    const rows = await listVehicleTrips(db(), actor, { workspaceId: ws.id, since: ago(24), perVehicle: 2 });
    const of = (id: string) => rows.filter((r) => r.vehicleId === id).map((r) => [+r.departedAt, r.total]);
    expect(of(busy.id)).toEqual([
      [+ago(1), 5],
      [+ago(2), 5],
    ]);
    expect(of(quiet.id)).toEqual([
      [+ago(10), 3],
      [+ago(11), 3],
    ]);
  });

  it("filters to one vehicle when given", async () => {
    const { ws, actor } = await setup("viewer");
    const a = await makeVehicle(db(), ws.id, { name: "A" });
    const b = await makeVehicle(db(), ws.id, { name: "B" });
    const riva = await makeSpot(db(), ws.id, "Riva");
    await makeTrip(db(), { workspaceId: ws.id, vehicleId: a.id, fromSpotId: riva.id, departedAt: ago(1) });
    await makeTrip(db(), { workspaceId: ws.id, vehicleId: b.id, fromSpotId: riva.id, departedAt: ago(1) });
    const rows = await listVehicleTrips(db(), actor, {
      workspaceId: ws.id,
      vehicleId: a.id,
      since: ago(24),
      perVehicle: 20,
    });
    expect(rows.map((r) => r.vehicleId)).toEqual([a.id]);
  });

  it("refuses outsiders and rejects a bad cap", async () => {
    const { ws, actor } = await setup("viewer");
    const outsider = await setup("admin");
    const input = { workspaceId: ws.id, since: ago(24), perVehicle: 20 };
    await expect(listVehicleTrips(db(), outsider.actor, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listVehicleTrips(db(), actor, { ...input, perVehicle: 0 })).rejects.toMatchObject({ code: "INVALID" });
  });
});
