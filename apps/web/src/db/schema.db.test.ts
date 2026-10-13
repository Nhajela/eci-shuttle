import { PairRequest } from "@eci-shuttle/shared";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { devices, people, routes, vehicleState, vehicles } from "./schema";

const db = () => testDb();

describe("schema-2", () => {
  it("reads NULL entries of routes.typical_leg_s back as null, not NaN", async () => {
    const ws = await makeWorkspace(db());
    const [r] = await db()
      .insert(routes)
      .values({ workspaceId: ws.id, name: "R", spotIds: [], typicalLegS: [600, null] })
      .returning();
    const [back] = await db().select().from(routes).where(eq(routes.id, r.id));
    expect(back.typicalLegS).toEqual([600, null]);
    expect(r.typicalLegS).toEqual([600, null]);
  });

  it("keeps a planned dwell per spot on a route (empty by default)", async () => {
    const ws = await makeWorkspace(db());
    const [r] = await db().insert(routes).values({ workspaceId: ws.id, name: "R", spotIds: [] }).returning();
    expect(r.plannedDwellS).toEqual({});
    const [u] = await db()
      .update(routes)
      .set({ plannedDwellS: { "spot-a": 120 } })
      .where(eq(routes.id, r.id))
      .returning();
    expect(u.plannedDwellS).toEqual({ "spot-a": 120 });
  });

  it("bumps updated_at on every update that doesn't set it", async () => {
    const p = await makePerson(db(), { updatedAt: new Date("2026-01-01T00:00:00Z") });
    const [u] = await db().update(people).set({ firstName: "New" }).where(eq(people.id, p.id)).returning();
    expect(u.updatedAt.getTime()).toBeGreaterThan(p.updatedAt.getTime());
  });

  it("has nullable since-columns for the alerts", async () => {
    const ws = await makeWorkspace(db());
    const at = new Date("2026-10-13T04:00:00Z");
    const [d] = await db()
      .insert(devices)
      .values({ workspaceId: ws.id, label: "P", tokenHash: crypto.randomUUID() })
      .returning();
    expect(d.permissionLostSince).toBeNull();
    expect(d.lowBatterySince).toBeNull();
    const [d2] = await db()
      .update(devices)
      .set({ permissionLostSince: at, lowBatterySince: at })
      .where(eq(devices.id, d.id))
      .returning();
    expect(d2.permissionLostSince).toEqual(at);
    expect(d2.lowBatterySince).toEqual(at);

    const [v] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Bus" }).returning();
    const [s] = await db()
      .insert(vehicleState)
      .values({ vehicleId: v.id, workspaceId: ws.id, offRouteSince: at })
      .returning();
    expect(s.offRouteSince).toEqual(at);
  });
});

describe("PairRequest.simulated", () => {
  const base = { code: "123456", model: "m", appVersion: "1", updateId: null, pushToken: null };
  it("is optional and accepts a boolean", () => {
    expect(PairRequest.parse(base).simulated).toBeUndefined();
    expect(PairRequest.parse({ ...base, simulated: true }).simulated).toBe(true);
    expect(() => PairRequest.parse({ ...base, simulated: "yes" })).toThrow();
  });
});
