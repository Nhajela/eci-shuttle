import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { auditLog, legStats, routes, spots } from "@/db/schema";
import { createRoute, listRoutes, updateRoute } from "./routes";

const db = () => testDb();
const offline = { fetch: vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch };
const osrm = (coords: [number, number][]) => ({
  fetch: vi.fn(
    async () => new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: { coordinates: coords } }] })),
  ) as unknown as typeof fetch,
});

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor } = await makeAdmin(db(), ws.id, role);
  const [riva, circle, party] = await db()
    .insert(spots)
    .values([
      { workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.63, lng: 73.73 },
      { workspaceId: ws.id, name: "Circle", shortName: "Circle", lat: 15.64, lng: 73.72 },
      { workspaceId: ws.id, name: "Party", shortName: "Party", lat: 15.65, lng: 73.71 },
    ])
    .returning();
  return { ws, actor, riva, circle, party };
}

const auditFor = (id: string) => db().select().from(auditLog).where(eq(auditLog.entityId, id)).orderBy(auditLog.id);

describe("createRoute", () => {
  it("stores ordered spots and the OSRM path, audited route.create", async () => {
    const { ws, actor, riva, circle } = await setup();
    const deps = osrm([
      [73.73, 15.63],
      [73.725, 15.635],
      [73.72, 15.64],
      [73.725, 15.636],
      [73.73, 15.6301],
    ]);
    const r = await createRoute(
      db(),
      actor,
      { workspaceId: ws.id, name: "Riva loop", spotIds: [riva.id, circle.id, riva.id] },
      deps,
    );
    expect(r).toMatchObject({ name: "Riva loop", spotIds: [riva.id, circle.id, riva.id], pathSource: "osrm" });
    expect(r.path).toHaveLength(5);
    expect(r.spotPathIdx).toEqual([0, 2, 4]);
    const audit = await auditFor(r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "route.create", entity: "route", workspaceId: ws.id });
  });

  it("falls back to straight segments when OSRM is unreachable", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    expect(r.pathSource).toBe("straight");
    expect(r.path).toEqual([
      { lat: riva.lat, lng: riva.lng },
      { lat: circle.lat, lng: circle.lng },
    ]);
    expect(r.spotPathIdx).toEqual([0, 1]);
  });

  it("refuses archived spots, other workspaces' spots and unknown ids (INVALID), writing nothing", async () => {
    const { ws, actor, riva, circle } = await setup();
    const other = await setup();
    await db().update(spots).set({ archivedAt: new Date() }).where(eq(spots.id, circle.id));
    for (const spotIds of [
      [riva.id, circle.id],
      [riva.id, other.riva.id],
      [riva.id, "00000000-0000-4000-8000-000000000000"],
    ]) {
      await expect(createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds }, offline)).rejects.toMatchObject(
        {
          code: "INVALID",
        },
      );
    }
    expect(await db().select().from(routes).where(eq(routes.workspaceId, ws.id))).toHaveLength(0);
  });

  it("validates input (one spot is INVALID) and needs ops", async () => {
    const { ws, actor, riva, circle } = await setup();
    await expect(
      createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id] }, offline),
    ).rejects.toMatchObject({ code: "INVALID" });
    const viewer = await makeAdmin(db(), ws.id, "viewer");
    await expect(
      createRoute(db(), viewer.actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("updateRoute", () => {
  it("renaming keeps the path and bumps version; audited with only the changed fields", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const deps = osrm([[0, 0]]);
    const u = await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, name: "Renamed", version: 1 }, deps);
    expect(u).toMatchObject({ name: "Renamed", version: 2, path: r.path, pathSource: "straight" });
    expect(deps.fetch).not.toHaveBeenCalled();
    const audit = await auditFor(r.id);
    expect(audit.at(-1)).toMatchObject({ action: "route.update", before: { name: "R", version: 1 } });
    expect(audit.at(-1)?.after).toMatchObject({ name: "Renamed", version: 2 });
  });

  it("sets the planned wait at each stop ('*') and per-stop overrides, audited, without touching the path", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const deps = osrm([[0, 0]]);
    const plan = { "*": 300, [circle.id]: 120 };
    const u = await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, plannedDwellS: plan }, deps);
    expect(u).toMatchObject({ plannedDwellS: plan, version: 2, path: r.path });
    expect(deps.fetch).not.toHaveBeenCalled();
    const audit = await auditFor(r.id);
    expect(audit.at(-1)).toMatchObject({ action: "route.update", before: { plannedDwellS: {} } });
    expect(audit.at(-1)?.after).toMatchObject({ plannedDwellS: plan });
    // {} clears the plan
    const cleared = await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, plannedDwellS: {} });
    expect(cleared.plannedDwellS).toEqual({});
  });

  it("refuses a planned wait for a spot that isn't on the route, or a silly number", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const up = (plannedDwellS: Record<string, number>) =>
      updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, plannedDwellS });
    await expect(up({ [party.id]: 60 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(up({ nope: 60 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(up({ "*": -1 })).rejects.toMatchObject({ code: "INVALID" });
    await expect(up({ "*": 4 * 3600 })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("new stops drop the planned wait of stops no longer on the route, and keep the default", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    await updateRoute(db(), actor, {
      workspaceId: ws.id,
      routeId: r.id,
      plannedDwellS: { "*": 300, [circle.id]: 120, [riva.id]: 60 },
    });
    const u = await updateRoute(
      db(),
      actor,
      { workspaceId: ws.id, routeId: r.id, spotIds: [riva.id, party.id] },
      offline,
    );
    expect(u.plannedDwellS).toEqual({ "*": 300, [riva.id]: 60 });
  });

  it("changing spotIds regenerates the path", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const u = await updateRoute(
      db(),
      actor,
      { workspaceId: ws.id, routeId: r.id, spotIds: [riva.id, party.id, riva.id] },
      osrm([
        [73.73, 15.63],
        [73.71, 15.65],
        [73.73, 15.63],
      ]),
    );
    expect(u).toMatchObject({ spotIds: [riva.id, party.id, riva.id], pathSource: "osrm", spotPathIdx: [0, 1, 2] });
  });

  it("changing spotIds clears the learned leg times; same spotIds or a rename keeps them", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    await db()
      .update(routes)
      .set({ typicalLegS: [420] })
      .where(eq(routes.id, r.id));
    const same = await updateRoute(
      db(),
      actor,
      { workspaceId: ws.id, routeId: r.id, spotIds: [riva.id, circle.id] },
      offline,
    );
    expect(same.typicalLegS).toEqual([420]);
    const renamed = await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, name: "R2" }, offline);
    expect(renamed.typicalLegS).toEqual([420]);
    const u = await updateRoute(
      db(),
      actor,
      { workspaceId: ws.id, routeId: r.id, spotIds: [riva.id, party.id] },
      offline,
    );
    expect(u.typicalLegS).toEqual([]);
  });

  it("a hand-edited path wins over regeneration and is marked manual, with spot indexes recomputed", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const path = [
      { lat: 15.63, lng: 73.73 },
      { lat: 15.635, lng: 73.726 },
      { lat: 15.64, lng: 73.72 },
    ];
    const deps = osrm([[0, 0]]);
    const u = await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, path, regeneratePath: true }, deps);
    expect(u).toMatchObject({ path, pathSource: "manual", spotPathIdx: [0, 2] });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("regeneratePath asks OSRM again", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    const u = await updateRoute(
      db(),
      actor,
      { workspaceId: ws.id, routeId: r.id, regeneratePath: true },
      osrm([
        [73.73, 15.63],
        [73.72, 15.64],
      ]),
    );
    expect(u.pathSource).toBe("osrm");
  });

  it("STALE_VERSION on a stale version; NOT_FOUND for another workspace's route", async () => {
    const { ws, actor, riva, circle } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    await updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, name: "A" }, offline);
    await expect(
      updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, name: "B", version: 1 }, offline),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const other = await setup();
    await expect(
      updateRoute(db(), other.actor, { workspaceId: other.ws.id, routeId: r.id, name: "X" }, offline),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses new spotIds containing an archived spot", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(db(), actor, { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id] }, offline);
    await db().update(spots).set({ archivedAt: new Date() }).where(eq(spots.id, party.id));
    await expect(
      updateRoute(db(), actor, { workspaceId: ws.id, routeId: r.id, spotIds: [riva.id, party.id] }, offline),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("listRoutes", () => {
  it("viewer sees non-archived routes of the workspace only, by name", async () => {
    const { ws, actor, riva, circle } = await setup();
    const b = await createRoute(db(), actor, { workspaceId: ws.id, name: "B", spotIds: [riva.id, circle.id] }, offline);
    await createRoute(db(), actor, { workspaceId: ws.id, name: "A", spotIds: [circle.id, riva.id] }, offline);
    const gone = await createRoute(
      db(),
      actor,
      { workspaceId: ws.id, name: "C", spotIds: [riva.id, circle.id] },
      offline,
    );
    await db().update(routes).set({ archivedAt: new Date(), typicalLegS: [] }).where(eq(routes.id, gone.id));
    await db()
      .update(routes)
      .set({ typicalLegS: [420] })
      .where(eq(routes.id, b.id));
    const other = await setup();
    await createRoute(
      db(),
      other.actor,
      { workspaceId: other.ws.id, name: "Z", spotIds: [other.riva.id, other.circle.id] },
      offline,
    );
    const viewer = await makeAdmin(db(), ws.id, "viewer");
    const list = await listRoutes(db(), viewer.actor, { workspaceId: ws.id });
    expect(list.map((r) => r.name)).toEqual(["A", "B"]);
    expect(list[1].typicalLegS).toEqual([420]);
    await expect(listRoutes(db(), other.actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads NULL typical_leg_s elements as null, not NaN", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    const r = await createRoute(
      db(),
      actor,
      { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id, party.id] },
      offline,
    );
    await db().execute(sql`update routes set typical_leg_s = '{NULL,300}' where id = ${r.id}`);
    const [route] = await listRoutes(db(), actor, { workspaceId: ws.id });
    expect(route.typicalLegS).toEqual([null, 300]);
  });

  it("legSamples[i] is the all-day regular-service sample count of leg i, 0 when unlearned", async () => {
    const { ws, actor, riva, circle, party } = await setup();
    await createRoute(
      db(),
      actor,
      { workspaceId: ws.id, name: "R", spotIds: [riva.id, circle.id, party.id, riva.id] },
      offline,
    );
    const stat = { workspaceId: ws.id, medianS: 300, p20S: 250, p80S: 350, level: "leg_day" as const };
    await db()
      .insert(legStats)
      .values([
        { ...stat, kind: "leg", fromSpotId: riva.id, toSpotId: circle.id, hourBucket: null, n: 12 },
        // hour rows, dwells and the reverse direction don't count
        { ...stat, kind: "leg", fromSpotId: riva.id, toSpotId: circle.id, hourBucket: 9, n: 4 },
        { ...stat, kind: "dwell", fromSpotId: riva.id, toSpotId: null, hourBucket: null, n: 30 },
        { ...stat, kind: "leg", fromSpotId: circle.id, toSpotId: riva.id, hourBucket: null, n: 7 },
        { ...stat, kind: "leg", fromSpotId: party.id, toSpotId: riva.id, hourBucket: null, n: 3 },
      ]);
    const [route] = await listRoutes(db(), actor, { workspaceId: ws.id });
    expect(route.legSamples).toEqual([12, 0, 3]);
  });
});
