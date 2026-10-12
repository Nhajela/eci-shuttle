/**
 * admin-vehicles: trip history read. ponytail: local workaround, no trips read service exists yet; move this to
 * a services module (e.g. catalog/vehicles.listVehicleTrips) when the contract adds one, and delete this file.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { spots, trips } from "@/db/schema";
import { type Actor, inWorkspace, readable } from "@/services/kernel";

const toSpot = alias(spots, "to_spot");

/** viewer+. Trips departed since `since`, newest first, with spot names. Capped at 500 rows. */
export async function recentTrips(db: Db, actor: Actor, input: { workspaceId: string; since: Date }) {
  readable(actor, input.workspaceId);
  return db
    .select({
      id: trips.id,
      vehicleId: trips.vehicleId,
      departedAt: trips.departedAt,
      arrivedAt: trips.arrivedAt,
      durationS: trips.durationS,
      quality: trips.quality,
      fromName: spots.name,
      toName: toSpot.name,
    })
    .from(trips)
    .innerJoin(spots, eq(spots.id, trips.fromSpotId))
    .leftJoin(toSpot, eq(toSpot.id, trips.toSpotId))
    .where(and(inWorkspace(trips, input.workspaceId), gte(trips.departedAt, input.since)))
    .orderBy(desc(trips.departedAt))
    .limit(500);
}
