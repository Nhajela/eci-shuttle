"use server";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import type { VehicleFormState } from "@/components/admin/vehicles/VehicleForm";
import { vehicleFields } from "@/components/admin/vehicles/view";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import {
  type CreateVehicleInput,
  createVehicle,
  type UpdateVehicleInput,
  updateVehicle,
} from "@/services/catalog/vehicles";
import { isServiceError, userMessage } from "@/services/kernel";

/** Create a vehicle, or update one when the form carries vehicleId. ops+ (the service checks too). */
export async function saveVehicle(_prev: VehicleFormState, form: FormData): Promise<VehicleFormState> {
  const w = form.get("w");
  const { actor, workspace } = await requireAdmin({ w: typeof w === "string" ? w : null, minRole: "ops" });
  const fields = { workspaceId: workspace.id, ...vehicleFields(form) };
  try {
    if ("vehicleId" in fields) await updateVehicle(db(), actor, fields as z.input<typeof UpdateVehicleInput>);
    else await createVehicle(db(), actor, fields as z.input<typeof CreateVehicleInput>);
  } catch (e) {
    if (!isServiceError(e)) console.error("saveVehicle", e);
    return { ok: false, message: userMessage(e) };
  }
  revalidatePath("/admin/vehicles");
  return { ok: true, message: "Saved." };
}
