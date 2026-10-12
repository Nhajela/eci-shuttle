/** svc-alerts factories: phones, vehicles, assignments, live state. */
import { randomUUID } from "node:crypto";
import type { Db } from "@/db";
import { deviceAssignments, devices, vehicleState, vehicles } from "@/db/schema";

export async function makeVehicle(db: Db, workspaceId: string, over: Partial<typeof vehicles.$inferInsert> = {}) {
  const [v] = await db
    .insert(vehicles)
    .values({ workspaceId, name: "Bus 1", ...over })
    .returning();
  return v;
}

export async function makeDevice(db: Db, workspaceId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db
    .insert(devices)
    .values({ workspaceId, label: "Ravi's phone", tokenHash: randomUUID(), ...over })
    .returning();
  return d;
}

/** A phone assigned to a vehicle (open assignment), optionally with a vehicle_state row. */
export async function makeAssignedDevice(
  db: Db,
  workspaceId: string,
  opts: {
    device?: Partial<typeof devices.$inferInsert>;
    vehicle?: Partial<typeof vehicles.$inferInsert>;
    state?: Partial<typeof vehicleState.$inferInsert>;
  } = {},
) {
  const vehicle = await makeVehicle(db, workspaceId, opts.vehicle);
  const device = await makeDevice(db, workspaceId, opts.device);
  await db
    .insert(deviceAssignments)
    .values({ workspaceId, deviceId: device.id, vehicleId: vehicle.id, startsAt: new Date(0) });
  if (opts.state) await db.insert(vehicleState).values({ vehicleId: vehicle.id, workspaceId, ...opts.state });
  return { vehicle, device };
}
