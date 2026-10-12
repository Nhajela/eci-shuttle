import { makeSpot, makeTrip, makeVehicle } from "@tests/factories/admin-vehicles";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { recentTrips } from "./trips";

const now = new Date("2026-10-12T06:00:00Z");
const ago = (h: number) => new Date(+now - h * 3_600_000);

describe("recentTrips", () => {
  it("returns this workspace's trips since the cutoff, newest first, with spot names", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const { actor } = await makeAdmin(db, ws.id, "viewer");
    const v = await makeVehicle(db, ws.id);
    const riva = await makeSpot(db, ws.id, "Riva");
    const circle = await makeSpot(db, ws.id, "Circle");
    await makeTrip(db, {
      workspaceId: ws.id,
      vehicleId: v.id,
      fromSpotId: riva.id,
      toSpotId: circle.id,
      departedAt: ago(2),
      arrivedAt: ago(1.5),
      durationS: 1800,
    });
    await makeTrip(db, {
      workspaceId: ws.id,
      vehicleId: v.id,
      fromSpotId: circle.id,
      toSpotId: null,
      departedAt: ago(1),
    });
    await makeTrip(db, { workspaceId: ws.id, vehicleId: v.id, fromSpotId: riva.id, departedAt: ago(24 * 8) });

    const other = await makeWorkspace(db);
    const ov = await makeVehicle(db, other.id);
    const os = await makeSpot(db, other.id, "Elsewhere");
    await makeTrip(db, { workspaceId: other.id, vehicleId: ov.id, fromSpotId: os.id, departedAt: ago(1) });

    const rows = await recentTrips(db, actor, { workspaceId: ws.id, since: ago(24 * 7), perVehicle: 20 });
    expect(rows.map((r) => [r.fromName, r.toName])).toEqual([
      ["Circle", null],
      ["Riva", "Circle"],
    ]);
    expect(rows[1]).toMatchObject({ vehicleId: v.id, durationS: 1800, quality: "clean", total: 2 });
  });

  it("caps rows per vehicle, not per workspace, and still counts every trip", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const { actor } = await makeAdmin(db, ws.id, "viewer");
    const busy = await makeVehicle(db, ws.id, { name: "Busy" });
    const quiet = await makeVehicle(db, ws.id, { name: "Quiet" });
    const riva = await makeSpot(db, ws.id, "Riva");
    // busy's 5 trips are all newer than quiet's 3: a workspace-wide cap of 4 would starve quiet
    for (let i = 0; i < 5; i++)
      await makeTrip(db, { workspaceId: ws.id, vehicleId: busy.id, fromSpotId: riva.id, departedAt: ago(1 + i) });
    for (let i = 0; i < 3; i++)
      await makeTrip(db, { workspaceId: ws.id, vehicleId: quiet.id, fromSpotId: riva.id, departedAt: ago(10 + i) });

    const rows = await recentTrips(db, actor, { workspaceId: ws.id, since: ago(24), perVehicle: 2 });
    const of = (id: string) => rows.filter((r) => r.vehicleId === id);
    expect(of(busy.id).map((r) => [+r.departedAt, r.total])).toEqual([
      [+ago(1), 5],
      [+ago(2), 5],
    ]);
    expect(of(quiet.id).map((r) => [+r.departedAt, r.total])).toEqual([
      [+ago(10), 3],
      [+ago(11), 3],
    ]);
  });

  it("refuses someone without a role in the workspace", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const other = await makeWorkspace(db);
    const { actor } = await makeAdmin(db, other.id, "admin");
    await expect(recentTrips(db, actor, { workspaceId: ws.id, since: ago(24), perVehicle: 20 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
