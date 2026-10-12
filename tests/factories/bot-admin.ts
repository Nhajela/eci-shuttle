/** Factories for the bot admin tests: raw rows (the catalog/devices services are built in parallel tasks). */
import { randomUUID } from "node:crypto";
import type { Db } from "@/db";
import { devices, directives, routes, services, spots, vehicles } from "@/db/schema";

export async function makeDevice(db: Db, workspaceId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db
    .insert(devices)
    .values({ workspaceId, label: "Ravi's phone", tokenHash: randomUUID(), ...over })
    .returning();
  return d;
}

export async function makeVehicle(db: Db, workspaceId: string, name = "Bus 1") {
  const [v] = await db.insert(vehicles).values({ workspaceId, name }).returning();
  return v;
}

export async function makeSpot(db: Db, workspaceId: string, name = "Riva") {
  const [s] = await db.insert(spots).values({ workspaceId, name, shortName: name, lat: 15.6, lng: 73.7 }).returning();
  return s;
}

export async function makeService(db: Db, workspaceId: string, name = "Riva ↔ Circle") {
  const spot = await makeSpot(db, workspaceId);
  const [r] = await db
    .insert(routes)
    .values({ workspaceId, name: "Loop", spotIds: [spot.id] })
    .returning();
  const [s] = await db
    .insert(services)
    .values({
      workspaceId,
      name,
      kind: "regular",
      routeId: r.id,
      validFrom: "2026-10-01",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "20:00",
      pattern: { kind: "every", everyMin: 20 },
    })
    .returning();
  return s;
}

export async function makeSilence(db: Db, workspaceId: string, deviceId: string, startsAt: Date, endsAt: Date) {
  const [d] = await db
    .insert(directives)
    .values({ workspaceId, deviceId, kind: "silence_until", startsAt, endsAt })
    .returning();
  return d;
}
