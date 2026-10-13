/** svc-catalog: vehicles (SPEC §3, §7 Vehicles). ops+ writes, viewer+ reads. */
import { Id, VehicleCreateFields, VehicleUpdateFields, withWorkspace } from "@eci-shuttle/shared";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "@/db";
import { spots, trips, vehicles } from "@/db/schema";
import type { Vehicle } from "@/db/types";
import { bumpConfigs } from "@/services/devices/config";
import {
  type Actor,
  checkVersion,
  getInWorkspace,
  inWorkspace,
  mutate,
  parseInput,
  readable,
  requireRole,
} from "../kernel";

export const CreateVehicleInput = withWorkspace(VehicleCreateFields);
export const UpdateVehicleInput = withWorkspace(VehicleUpdateFields);

/** ops+. Audited vehicle.create. */
export async function createVehicle(db: Db, actor: Actor, input: z.input<typeof CreateVehicleInput>): Promise<Vehicle> {
  const values = parseInput(CreateVehicleInput, input);
  requireRole(actor, values.workspaceId, "ops");
  return mutate(
    db,
    actor,
    { action: "vehicle.create", entity: "vehicle", workspaceId: values.workspaceId },
    async (tx) => {
      const [row] = await tx.insert(vehicles).values(values).returning();
      return { before: null, after: row, result: row };
    },
  );
}

/** ops+. STALE_VERSION on stale version. Deactivating bumps the configs of its phones (they stop tracking). */
export async function updateVehicle(db: Db, actor: Actor, input: z.input<typeof UpdateVehicleInput>): Promise<Vehicle> {
  const { workspaceId, vehicleId, version, ...fields } = parseInput(UpdateVehicleInput, input);
  requireRole(actor, workspaceId, "ops");
  const meta = { action: "vehicle.update", entity: "vehicle", entityId: vehicleId, workspaceId };
  return mutate(db, actor, meta, async (tx) => {
    const before = await getInWorkspace(tx, vehicles, workspaceId, vehicleId, "vehicle", { forUpdate: true });
    checkVersion(before, version, "vehicle");
    const [after] = await tx
      .update(vehicles)
      .set({ ...fields, version: sql`${vehicles.version} + 1`, updatedAt: new Date() })
      .where(eq(vehicles.id, vehicleId))
      .returning();
    // reactivating changes their windows too, so bump on any flip
    if (after.active !== before.active) await bumpConfigs(tx, { vehicleIds: [vehicleId] }, "vehicle.update");
    return { before, after, result: after };
  });
}

/** viewer+. Active first, by name. */
export async function listVehicles(db: Db, actor: Actor, input: { workspaceId: string }): Promise<Vehicle[]> {
  readable(actor, input.workspaceId);
  return db
    .select()
    .from(vehicles)
    .where(inWorkspace(vehicles, input.workspaceId))
    .orderBy(desc(vehicles.active), asc(vehicles.name));
}

export const ListVehicleTripsInput = z.object({
  workspaceId: Id,
  vehicleId: Id.optional(),
  since: z.date(),
  perVehicle: z.number().int().min(1).max(500),
});

const toSpot = alias(spots, "to_spot");

/**
 * viewer+. Each vehicle's newest `perVehicle` trips departed since `since` (optionally one vehicle), newest first,
 * with spot names. `total` is that vehicle's full trip count since `since`, so a card can say how many it hides.
 */
export async function listVehicleTrips(db: Db, actor: Actor, input: z.input<typeof ListVehicleTripsInput>) {
  const { workspaceId, vehicleId, since, perVehicle } = parseInput(ListVehicleTripsInput, input);
  readable(actor, workspaceId);
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
    .where(
      and(
        inWorkspace(trips, workspaceId),
        gte(trips.departedAt, since),
        vehicleId ? eq(trips.vehicleId, vehicleId) : undefined,
      ),
    )
    .as("ranked");
  const { rank, ...cols } = ranked._.selectedFields;
  return db.select(cols).from(ranked).where(lte(rank, perVehicle)).orderBy(desc(ranked.departedAt), asc(ranked.id));
}
