/** svc-catalog: vehicles (SPEC §3, §7 Vehicles). ops+ writes, viewer+ reads. */
import { notImplemented, VehicleCreateFields, VehicleUpdateFields, withWorkspace } from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Vehicle } from "@/db/types";
import type { Actor } from "../kernel";

export const CreateVehicleInput = withWorkspace(VehicleCreateFields);
export const UpdateVehicleInput = withWorkspace(VehicleUpdateFields);

/** ops+. Audited vehicle.create. */
export async function createVehicle(db: Db, actor: Actor, input: z.input<typeof CreateVehicleInput>): Promise<Vehicle> {
  return notImplemented(db, actor, input);
}

/** ops+. STALE_VERSION on stale version. Deactivating bumps the configs of its phones (they stop tracking). */
export async function updateVehicle(db: Db, actor: Actor, input: z.input<typeof UpdateVehicleInput>): Promise<Vehicle> {
  return notImplemented(db, actor, input);
}

/** viewer+. Active first, by name. */
export async function listVehicles(db: Db, actor: Actor, input: { workspaceId: string }): Promise<Vehicle[]> {
  return notImplemented(db, actor, input);
}
