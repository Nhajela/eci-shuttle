import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { routes, spots, vehicleBreaks, vehicleState, vehicles } from "@/db/schema";
import { staffMap } from "./staff-map";

const db = () => testDb();
const NOW = new Date("2026-10-13T06:00:00Z");

describe("staffMap", () => {
  it("spots, active route paths and every vehicle with a position, for any member; breaks are named", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const [riva] = await db()
      .insert(spots)
      .values({ workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.67, lng: 73.71, radiusM: 200 })
      .returning();
    await db()
      .insert(routes)
      .values({
        workspaceId: ws.id,
        name: "R",
        spotIds: [riva.id, riva.id],
        path: [
          { lat: 1, lng: 2 },
          { lat: 3, lng: 4 },
        ],
      });
    const [s1, s2, s3] = await db()
      .insert(vehicles)
      .values([
        { workspaceId: ws.id, name: "Shuttle 1" },
        { workspaceId: ws.id, name: "Shuttle 2" },
        { workspaceId: ws.id, name: "Old", active: false },
      ])
      .returning();
    await db()
      .insert(vehicleState)
      .values([
        { vehicleId: s1.id, workspaceId: ws.id, phase: "en_route", lat: 15.66, lng: 73.71, offRoute: true },
        { vehicleId: s2.id, workspaceId: ws.id, phase: "offline" },
        { vehicleId: s3.id, workspaceId: ws.id, phase: "at_spot", lat: 15.6, lng: 73.7 },
      ]);
    await db().insert(vehicleBreaks).values({ workspaceId: ws.id, vehicleId: s1.id, startsAt: NOW, endsAt: null });
    const m = await staffMap(db(), actor, { workspaceId: ws.id }, new Date(NOW.getTime() + 1000));
    expect(m.spots).toEqual([{ id: riva.id, name: "Riva", lat: 15.67, lng: 73.71, radiusM: 200 }]);
    expect(m.paths).toEqual([
      [
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ],
    ]);
    expect(m.markers).toEqual([
      { id: s1.id, name: "Shuttle 1 · on break", colour: null, lat: 15.66, lng: 73.71, problem: true },
    ]);
  });

  it("refuses people outside the workspace", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), (await makeWorkspace(db())).id, "admin");
    await expect(staffMap(db(), actor, { workspaceId: ws.id }, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
