import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/db/schema";
import { bumpConfigs } from "@/services/devices/config";
import { createVehicle, listVehicles, updateVehicle } from "./vehicles";

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
