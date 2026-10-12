"use server";
/** admin-schedule server actions: parse the form, build the Actor, call the schedule service, map errors. */
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/admin/schedule/action-form";
import { assignmentRange, exceptionFormToInput, serviceFormToInput } from "@/components/admin/schedule/schedule";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import {
  addException,
  assignServiceVehicle,
  createService,
  duplicateAsSpecial,
  removeException,
  unassignServiceVehicle,
  updateService,
} from "@/services/catalog/schedule";
import { type Actor, isServiceError, userMessage } from "@/services/kernel";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function run(fd: FormData, fn: (actor: Actor, workspaceId: string) => Promise<unknown>): Promise<ActionState> {
  const { actor, workspace } = await requireAdmin({ w: str(fd, "w") || null, minRole: "ops" });
  try {
    await fn(actor, workspace.id);
  } catch (e) {
    if (!isServiceError(e)) console.error("admin-schedule action failed", e);
    return { ok: false, error: userMessage(e) };
  }
  revalidatePath("/admin/schedule");
  return { ok: true };
}

export async function saveServiceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) => {
    const fields = serviceFormToInput(fd);
    const serviceId = str(fd, "serviceId");
    return serviceId
      ? updateService(db(), actor, { ...fields, workspaceId, serviceId, version: Number(str(fd, "version")) })
      : createService(db(), actor, { ...fields, workspaceId });
  });
}

export async function duplicateServiceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) =>
    duplicateAsSpecial(db(), actor, {
      workspaceId,
      serviceId: str(fd, "serviceId"),
      name: str(fd, "name"),
      validFrom: str(fd, "validFrom"),
      validTo: str(fd, "validTo"),
    }),
  );
}

export async function addExceptionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) => addException(db(), actor, { ...exceptionFormToInput(fd), workspaceId }));
}

export async function removeExceptionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) =>
    removeException(db(), actor, { workspaceId, exceptionId: str(fd, "exceptionId") }),
  );
}

export async function assignVehicleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) =>
    assignServiceVehicle(db(), actor, {
      workspaceId,
      serviceId: str(fd, "serviceId"),
      vehicleId: str(fd, "vehicleId"),
      ...assignmentRange(str(fd, "date"), str(fd, "start"), str(fd, "end"), str(fd, "lastDate") || undefined),
    }),
  );
}

export async function unassignVehicleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, (actor, workspaceId) =>
    unassignServiceVehicle(db(), actor, { workspaceId, serviceVehicleId: str(fd, "serviceVehicleId") }),
  );
}
