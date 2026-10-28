import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { NoSignalLeg } from "@/db/schema";
import { auditLog, routes, spots } from "@/db/schema";
import { systemActor } from "@/services/kernel";
import { loadDeadZones, setLegNoSignal } from "./dead-zones";

const db = () => testDb();
const NOW = new Date("2026-10-28T10:00:00Z");

/** Nanu → Riva → Circle → Namaka → Circle → Riva → Nanu: 6 legs (0..5) */
async function world(noSignalLegs: NoSignalLeg[] = [], typicalLegS: (number | null)[] = []) {
  const ws = await makeWorkspace(db());
  const names = ["Nanu", "Riva", "Circle", "Namaka"];
  const rows = await db()
    .insert(spots)
    .values(names.map((n, i) => ({ workspaceId: ws.id, name: n, shortName: n, lat: 15.6 + i * 0.01, lng: 73.7 })))
    .returning();
  const by = Object.fromEntries(rows.map((s) => [s.name, s.id]));
  const spotIds = ["Nanu", "Riva", "Circle", "Namaka", "Circle", "Riva", "Nanu"].map((n) => by[n] as string);
  const [route] = await db()
    .insert(routes)
    .values({ workspaceId: ws.id, name: "Long loop", spotIds, noSignalLegs, typicalLegS })
    .returning();
  return { ws, route, spotIds };
}

describe("loadDeadZones", () => {
  it("is empty when nothing is marked", async () => {
    const w = await world();
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([]);
  });

  it("returns a manual leg as a whole-leg zone with the learned typical time", async () => {
    const w = await world([{ legIndex: 2, source: "manual" }], [null, null, 240, null, null, null]);
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([
      {
        routeId: w.route.id,
        legIndex: 2,
        fromSpotId: w.spotIds[2],
        toSpotId: w.spotIds[3],
        startAlongM: null,
        endAlongM: null,
        source: "manual",
        typicalLegS: 240,
      },
    ]);
  });

  it("returns a detected stretch with its metres; typicalLegS null when not learned", async () => {
    const w = await world([{ legIndex: 3, source: "detected", startAlongM: 5200, endAlongM: 5900, trips: 5, days: 3 }]);
    expect(await loadDeadZones(db(), w.ws.id)).toMatchObject([
      { legIndex: 3, source: "detected", startAlongM: 5200, endAlongM: 5900, typicalLegS: null },
    ]);
  });

  it("manual wins over detected for the same leg; other legs keep their detected stretches", async () => {
    const w = await world([
      { legIndex: 2, source: "detected", startAlongM: 100, endAlongM: 300, trips: 4, days: 2 },
      { legIndex: 2, source: "detected", startAlongM: 500, endAlongM: 700, trips: 4, days: 2 },
      { legIndex: 2, source: "manual" },
      { legIndex: 3, source: "detected", startAlongM: 900, endAlongM: 1100, trips: 4, days: 2 },
    ]);
    const z = await loadDeadZones(db(), w.ws.id);
    expect(z.map((x) => [x.legIndex, x.source, x.startAlongM])).toEqual([
      [2, "manual", null],
      [3, "detected", 900],
    ]);
  });

  it("skips entries whose leg no longer exists, and archived routes", async () => {
    const w = await world([{ legIndex: 9, source: "manual" }]);
    expect(await loadDeadZones(db(), w.ws.id)).toEqual([]);
    const v = await world([{ legIndex: 0, source: "manual" }]);
    await db().update(routes).set({ archivedAt: NOW }).where(eq(routes.id, v.route.id));
    expect(await loadDeadZones(db(), v.ws.id)).toEqual([]);
  });

  it("is scoped to the workspace", async () => {
    const a = await world([{ legIndex: 0, source: "manual" }]);
    const b = await world();
    expect(await loadDeadZones(db(), b.ws.id)).toEqual([]);
    expect(await loadDeadZones(db(), a.ws.id)).toHaveLength(1);
  });

  it("is a single query", async () => {
    const w = await world([{ legIndex: 0, source: "manual" }]);
    let n = 0;
    const counted = new Proxy(db(), {
      get(t, k, r) {
        if (k === "select") n++;
        return Reflect.get(t, k, r);
      },
    });
    await loadDeadZones(counted, w.ws.id);
    expect(n).toBe(1);
  });
});

describe("setLegNoSignal", () => {
  const audits = (routeId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, routeId));

  it("an admin marks a leg: stored, version bumped, exactly one audit row", async () => {
    const w = await world();
    const { actor } = await makeAdmin(db(), w.ws.id, "admin");
    const r = await setLegNoSignal(
      db(),
      actor,
      { workspaceId: w.ws.id, routeId: w.route.id, legIndex: 2, noSignal: true },
      NOW,
    );
    expect(r.noSignalLegs).toEqual([{ legIndex: 2, source: "manual" }]);
    expect(r.version).toBe(w.route.version + 1);
    const a = await audits(w.route.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "route.no_signal", entity: "route", workspaceId: w.ws.id });
  });

  it("marking twice is idempotent (still one manual entry); unmarking removes it and keeps detected ones", async () => {
    const w = await world([{ legIndex: 2, source: "detected", startAlongM: 1, endAlongM: 200, trips: 3, days: 2 }]);
    const { actor } = await makeAdmin(db(), w.ws.id, "admin");
    const input = { workspaceId: w.ws.id, routeId: w.route.id, legIndex: 2 };
    await setLegNoSignal(db(), actor, { ...input, noSignal: true }, NOW);
    const twice = await setLegNoSignal(db(), actor, { ...input, noSignal: true }, NOW);
    expect(twice.noSignalLegs.filter((l) => l.source === "manual")).toHaveLength(1);
    const off = await setLegNoSignal(db(), actor, { ...input, noSignal: false }, NOW);
    expect(off.noSignalLegs).toEqual([
      { legIndex: 2, source: "detected", startAlongM: 1, endAlongM: 200, trips: 3, days: 2 },
    ]);
  });

  it("ops, viewer and other workspaces' admins are FORBIDDEN and nothing is written", async () => {
    const w = await world();
    const other = await makeWorkspace(db());
    const input = { workspaceId: w.ws.id, routeId: w.route.id, legIndex: 2, noSignal: true };
    for (const actor of [
      (await makeAdmin(db(), w.ws.id, "ops")).actor,
      (await makeAdmin(db(), w.ws.id, "viewer")).actor,
      (await makeAdmin(db(), other.id, "admin")).actor,
    ])
      await expect(setLegNoSignal(db(), actor, input, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await audits(w.route.id)).toHaveLength(0);
  });

  it("rejects a leg that does not exist, a route of another workspace, and bad input", async () => {
    const w = await world();
    const o = await world();
    const { actor } = await makeAdmin(db(), w.ws.id, "admin");
    const base = { workspaceId: w.ws.id, routeId: w.route.id, noSignal: true };
    await expect(setLegNoSignal(db(), actor, { ...base, legIndex: 6 }, NOW)).rejects.toMatchObject({ code: "INVALID" });
    await expect(setLegNoSignal(db(), actor, { ...base, legIndex: -1 }, NOW)).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(setLegNoSignal(db(), actor, { ...base, routeId: o.route.id, legIndex: 0 }, NOW)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(await audits(w.route.id)).toHaveLength(0);
  });

  it("checks the version when given", async () => {
    const w = await world();
    const { actor } = await makeAdmin(db(), w.ws.id, "admin");
    await expect(
      setLegNoSignal(
        db(),
        actor,
        { workspaceId: w.ws.id, routeId: w.route.id, legIndex: 0, noSignal: true, version: 99 },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("the system actor passes the role check", async () => {
    const w = await world();
    const r = await setLegNoSignal(
      db(),
      systemActor("test"),
      { workspaceId: w.ws.id, routeId: w.route.id, legIndex: 0, noSignal: true },
      NOW,
    );
    expect(r.noSignalLegs).toHaveLength(1);
  });
});
