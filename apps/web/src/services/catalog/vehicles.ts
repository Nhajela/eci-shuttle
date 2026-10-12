/** svc-catalog: vehicles (SPEC §3, §7 Vehicles). ops+ writes, viewer+ reads. */
import { VehicleCreateFields, VehicleUpdateFields, withWorkspace } from "@eci-shuttle/shared";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { vehicles } from "@/db/schema";
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
