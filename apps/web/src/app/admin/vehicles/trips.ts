/**
 * admin-vehicles: trip history read. ponytail: local workaround, no trips read service exists yet; move this to
 * a services module (e.g. catalog/vehicles.listVehicleTrips) when the contract adds one, and delete this file.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { spots, trips } from "@/db/schema";
import { type Actor, inWorkspace, readable } from "@/services/kernel";

const toSpot = alias(spots, "to_spot");

/**
 * viewer+. Each vehicle's newest `perVehicle` trips departed since `since`, newest first, with spot names.
 * `total` is that vehicle's full trip count since `since`, so a card can say how many it is not showing.
 */
export async function recentTrips(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; since: Date; perVehicle: number },
) {
  readable(actor, input.workspaceId);
  const ranked = db
    .select({
      id: trips.id,
      vehicleId: trips.vehicleId,
      departedAt: trips.departedAt,
      arrivedAt: trips.arrivedAt,
      durationS: trips.durationS,
      quality: trips.quality,
      fromName: sql<string>`${spots.name}`.as("from_name"),
      toName: sql<string | null>`${toSpot.name}`.as("to_name"),
      rank: sql<number>`row_number() over (partition by ${trips.vehicleId} order by ${trips.departedAt} desc)`.as(
        "rank",
      ),
      total: sql<number>`(count(*) over (partition by ${trips.vehicleId}))::int`.as("total"),
    })
    .from(trips)
    .innerJoin(spots, eq(spots.id, trips.fromSpotId))
    .leftJoin(toSpot, eq(toSpot.id, trips.toSpotId))
    .where(and(inWorkspace(trips, input.workspaceId), gte(trips.departedAt, input.since)))
    .as("ranked");
  const { rank, ...cols } = ranked._.selectedFields;
  return db
    .select(cols)
    .from(ranked)
    .where(lte(rank, input.perVehicle))
    .orderBy(desc(ranked.departedAt), asc(ranked.id));
}
