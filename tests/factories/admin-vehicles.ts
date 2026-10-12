/** admin-vehicles factories: raw rows for reads (writes are the services' own tests). */
import type { Db } from "@/db";
import { spots, trips, vehicles } from "@/db/schema";

export async function makeVehicle(db: Db, workspaceId: string, over: Partial<typeof vehicles.$inferInsert> = {}) {
  const [v] = await db
    .insert(vehicles)
    .values({ workspaceId, name: "Van", ...over })
    .returning();
  return v;
}

export async function makeSpot(db: Db, workspaceId: string, name: string) {
  const [s] = await db.insert(spots).values({ workspaceId, name, shortName: name, lat: 15.6, lng: 73.7 }).returning();
  return s;
}

export async function makeTrip(db: Db, row: typeof trips.$inferInsert) {
  const [t] = await db.insert(trips).values(row).returning();
  return t;
}
