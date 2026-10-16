import { makeVehicle } from "@tests/factories/admin-vehicles";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/db/schema";
import { activeBreaks, breakEnd, endBreak, startBreak } from "./breaks";

const db = () => testDb();
const T = new Date("2026-10-13T06:00:00Z"); // 11:30 IST
const at = (min: number) => new Date(T.getTime() + min * 60_000);

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor } = await makeAdmin(db(), ws.id, role);
  const v = await makeVehicle(db(), ws.id, { name: "Shuttle 1" });
  return { ws, actor, v };
}

describe("startBreak", () => {
  it("starts a timed break now, audits vehicle.break, and shows in activeBreaks until it ends", async () => {
    const { ws, actor, v } = await setup();
    const b = await startBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id, minutes: 20, note: "lunch" }, T);
    expect(b).toMatchObject({ vehicleId: v.id, startsAt: T, endsAt: at(20), endedAt: null, note: "lunch" });
    const rows = await db().select().from(auditLog).where(eq(auditLog.entityId, b.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "vehicle.break", entity: "vehicle_break", workspaceId: ws.id });
    expect((await activeBreaks(db(), ws.id, at(19))).get(v.id)?.id).toBe(b.id);
    expect((await activeBreaks(db(), ws.id, at(20))).has(v.id)).toBe(false);
  });

  it("open-ended without minutes; a second start replaces the current break's end", async () => {
    const { ws, actor, v } = await setup();
    const open = await startBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id }, T);
    expect(open.endsAt).toBeNull();
    expect(breakEnd(open)).toBeNull();
    expect((await activeBreaks(db(), ws.id, at(600))).has(v.id)).toBe(true);
    const again = await startBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id, minutes: 10 }, at(5));
    expect(again.id).toBe(open.id);
    expect(again.endsAt).toEqual(at(15));
    expect((await activeBreaks(db(), ws.id, at(15))).has(v.id)).toBe(false);
  });

  it("viewers can't, other workspaces' vehicles are NOT_FOUND", async () => {
    const { ws, v } = await setup();
    const viewer = await makeAdmin(db(), ws.id, "viewer");
    await expect(startBreak(db(), viewer.actor, { workspaceId: ws.id, vehicleId: v.id }, T)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const other = await setup();
    await expect(startBreak(db(), other.actor, { workspaceId: other.ws.id, vehicleId: v.id }, T)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });
});

describe("endBreak", () => {
  it("ends the current break now (audited), NOT_FOUND when not on one", async () => {
    const { ws, actor, v } = await setup();
    await expect(endBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id }, T)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const b = await startBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id, minutes: 30 }, T);
    const ended = await endBreak(db(), actor, { workspaceId: ws.id, vehicleId: v.id }, at(8));
    expect(ended).toMatchObject({ id: b.id, endedAt: at(8) });
    expect(breakEnd(ended)).toEqual(at(8));
    expect((await activeBreaks(db(), ws.id, at(9))).has(v.id)).toBe(false);
    const rows = await db().select().from(auditLog).where(eq(auditLog.entityId, b.id)).orderBy(auditLog.id);
    expect(rows.map((r) => r.action)).toEqual(["vehicle.break", "vehicle.break_end"]);
  });
});
