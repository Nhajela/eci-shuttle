/**
 * The live out-and-back route: Nanu → Riva → Circle → Namaka → Circle → Riva → Nanu along ONE road (north), 1 km
 * between stops. Riva, Circle and Nanu appear twice (Nanu is both ends of the loop).
 */
import { randomUUID } from "node:crypto";
import { pathLengthM } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import { deviceAssignments, devices, routes, services, serviceVehicles, spots, vehicles } from "@/db/schema";
import { makeWorkspace } from "./core";

export const KM_STEP = 0.009; // degrees of latitude per km
export const pointAt = (km: number) => ({ lat: 15.6 + km * KM_STEP, lng: 73.7 });
/** km along the road of each entry in spotIds */
export const STOP_KM = [0, 1, 2, 3, 2, 1, 0] as const;
export const STOP_NAMES = ["nanu", "riva", "circle", "namaka", "circle", "riva", "nanu"] as const;
const SHORT: Record<string, string> = { nanu: "Nanu", riva: "Riva", circle: "Circle", namaka: "Namaka" };

export async function makeOutAndBack(
  db: Db,
  over: { pattern?: "loop" | "times"; vehicleFrom?: Date; vehicleTo?: Date } = {},
) {
  const ws = await makeWorkspace(db);
  const rows = await db
    .insert(spots)
    .values(
      ["nanu", "riva", "circle", "namaka"].map((n, i) => ({
        workspaceId: ws.id,
        name: SHORT[n] as string,
        shortName: SHORT[n] as string,
        ...pointAt(i),
        radiusM: 75,
      })),
    )
    .returning();
  const id = Object.fromEntries(rows.map((r) => [r.shortName.toLowerCase(), r.id])) as Record<
    "nanu" | "riva" | "circle" | "namaka",
    string
  >;
  const spotIds = STOP_NAMES.map((n) => id[n]);
  const path = STOP_KM.map(pointAt);
  const [route] = await db
    .insert(routes)
    .values({ workspaceId: ws.id, name: "Out and back", spotIds, path, spotPathIdx: [0, 1, 2, 3, 4, 5, 6] })
    .returning();
  const [service] = await db
    .insert(services)
    .values({
      workspaceId: ws.id,
      name: "Loop",
      kind: "regular",
      routeId: route.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:30",
      endTime: "11:00",
      pattern: over.pattern === "times" ? { kind: "times", times: ["09:00", "09:40"] } : { kind: "loop" },
    })
    .returning();
  const [vehicle] = await db.insert(vehicles).values({ workspaceId: ws.id, name: "Bus 1" }).returning();
  const [device] = await db
    .insert(devices)
    .values({ workspaceId: ws.id, label: "Phone 1", tokenHash: randomUUID() })
    .returning();
  const from = over.vehicleFrom ?? new Date("2026-10-13T08:00:00+05:30");
  const to = over.vehicleTo ?? new Date("2026-10-13T12:00:00+05:30");
  await db.insert(deviceAssignments).values({
    workspaceId: ws.id,
    deviceId: device.id,
    vehicleId: vehicle.id,
    startsAt: new Date(from.getTime() - 2 * 3_600_000),
  });
  await db
    .insert(serviceVehicles)
    .values({ workspaceId: ws.id, serviceId: service.id, vehicleId: vehicle.id, startsAt: from, endsAt: to });
  return {
    ws,
    id,
    route,
    service,
    vehicle,
    device,
    /** metres along the route path at each entry of spotIds */
    cumM: STOP_KM.map((_, i) => pathLengthM(path.slice(0, i + 1))),
  };
}
