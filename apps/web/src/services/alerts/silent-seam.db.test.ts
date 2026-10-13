// Watchdog / phone health on the REAL desiredConfig + trackingWindows (the other suites fake them):
// a service window that is already running must keep its real start, not `now`.
import { istToEpoch } from "@eci-shuttle/shared";
import { makeAssignedDevice } from "@tests/factories/alerts";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { routes, services, serviceVehicles } from "@/db/schema";
import { listPhones } from "@/services/devices/phones";
import { detectProblems } from "./watchdog";

const db = () => testDb();
const NOW = new Date(istToEpoch("2026-10-15", "10:00"));
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

async function runningService() {
  const ws = await makeWorkspace(db());
  const { vehicle, device } = await makeAssignedDevice(db(), ws.id, {
    device: { lastSyncAt: ago(10), reportedMode: "idle" },
    state: { lastPingAt: ago(30), phase: "en_route" },
  });
  const [r] = await db().insert(routes).values({ workspaceId: ws.id, name: "Loop", spotIds: [] }).returning();
  const [s] = await db()
    .insert(services)
    .values({
      workspaceId: ws.id,
      name: "Riva ↔ Circle",
      kind: "regular",
      routeId: r.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "12:00",
      pattern: { kind: "every", everyMin: 30 },
    })
    .returning();
  await db()
    .insert(serviceVehicles)
    .values({
      workspaceId: ws.id,
      serviceId: s.id,
      vehicleId: vehicle.id,
      startsAt: new Date(istToEpoch("2026-10-15", "07:00")),
      endsAt: new Date(istToEpoch("2026-10-15", "13:00")),
    });
  return { ws, vehicle, device };
}

describe("silent / mode_mismatch inside a running service window", () => {
  it("watchdog flags a phone that went quiet and reports idle mid-service", async () => {
    const { ws, vehicle, device } = await runningService();
    const problems = await detectProblems(db(), ws.id, NOW);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "silent", vehicleId: vehicle.id, since: ago(30) }));
    expect(problems).toContainEqual(
      expect.objectContaining({
        kind: "mode_mismatch",
        deviceId: device.id,
        message: expect.stringContaining("should be active"),
      }),
    );
  });

  it("phone health shows it silent", async () => {
    const { ws, device } = await runningService();
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const [h] = await listPhones(db(), actor, { workspaceId: ws.id }, NOW);
    expect(h).toMatchObject({ device: { id: device.id }, desiredMode: "active", silent: true });
  });
});
