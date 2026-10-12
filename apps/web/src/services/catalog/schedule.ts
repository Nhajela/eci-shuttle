/**
 * svc-catalog: services (the schedule), one-day exceptions and vehicle staffing (SPEC §3, §7 Schedule).
 * ops+ writes, viewer+ reads. Every write that can change a vehicle's tracking windows calls
 * devices/config.bumpConfigs for the affected vehicles in the same transaction.
 */
import {
  checkException,
  type Departure,
  type IsoDate,
  notImplemented,
  ServiceCreateFields,
  ServiceExceptionFields,
  ServiceUpdateFields,
  ServiceVehicleAssignFields,
  ServiceVehicleUnassignFields,
  withWorkspace,
} from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Service, ServiceException, ServiceVehicle } from "@/db/types";
import type { Actor } from "../kernel";

export const CreateServiceInput = withWorkspace(ServiceCreateFields);
export const UpdateServiceInput = withWorkspace(ServiceUpdateFields);
export const AddExceptionInput = withWorkspace(ServiceExceptionFields).superRefine(checkException);
export const RemoveExceptionInput = z.object({ workspaceId: z.uuid(), exceptionId: z.uuid() });
export const AssignServiceVehicleInput = withWorkspace(ServiceVehicleAssignFields);
export const UnassignServiceVehicleInput = withWorkspace(ServiceVehicleUnassignFields);

/** ops+. validTo ≥ validFrom (INVALID). Route must be in the workspace. */
export async function createService(db: Db, actor: Actor, input: z.input<typeof CreateServiceInput>): Promise<Service> {
  return notImplemented(db, actor, input);
}

/** ops+. STALE_VERSION on stale version. Bumps configs of vehicles assigned to it. */
export async function updateService(db: Db, actor: Actor, input: z.input<typeof UpdateServiceInput>): Promise<Service> {
  return notImplemented(db, actor, input);
}

/** ops+. "Duplicate as special": a copy with kind special, for one date range, no vehicles. */
export async function duplicateAsSpecial(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; serviceId: string; name: string; validFrom: IsoDate; validTo: IsoDate },
): Promise<Service> {
  return notImplemented(db, actor, input);
}

/**
 * ops+. cancel_day / cancel_departure / add_departure / shift_minutes for one IST date. The departure named must
 * exist in that day's plan for cancel/shift (INVALID otherwise); duplicates → CONFLICT. Audited service.exception.
 */
export async function addException(
  db: Db,
  actor: Actor,
  input: z.input<typeof AddExceptionInput>,
): Promise<ServiceException> {
  return notImplemented(db, actor, input);
}

/** ops+. Undo a one-day edit. Audited service.exception_remove. */
export async function removeException(db: Db, actor: Actor, input: z.input<typeof RemoveExceptionInput>): Promise<void> {
  return notImplemented(db, actor, input);
}

/** ops+. Vehicle runs the service for [startsAt, endsAt). Overlap with another assignment of it is allowed. */
export async function assignServiceVehicle(
  db: Db,
  actor: Actor,
  input: z.input<typeof AssignServiceVehicleInput>,
): Promise<ServiceVehicle> {
  return notImplemented(db, actor, input);
}

export async function unassignServiceVehicle(
  db: Db,
  actor: Actor,
  input: z.input<typeof UnassignServiceVehicleInput>,
): Promise<void> {
  return notImplemented(db, actor, input);
}

export type ScheduleDay = {
  date: IsoDate;
  services: {
    service: Service;
    exceptions: ServiceException[];
    vehicles: ServiceVehicle[];
    /** after exceptions (expandServiceDepartures) */
    departures: Departure[];
  }[];
};

/** viewer+. The week view (or one day: days 1). Archived services excluded. */
export async function getSchedule(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; from: IsoDate; days: number },
): Promise<ScheduleDay[]> {
  return notImplemented(db, actor, input);
}
