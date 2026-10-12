/**
 * svc-catalog: services (the schedule), one-day exceptions and vehicle staffing (SPEC §3, §7 Schedule).
 * ops+ writes, viewer+ reads. Every write that can change a vehicle's tracking windows calls
 * devices/config.bumpConfigs for the affected vehicles in the same transaction.
 */
import {
  checkException,
  type Departure,
  expandServiceDepartures,
  Id,
  IsoDate,
  ServiceCreateFields,
  type ServiceExceptionDef,
  ServiceExceptionFields,
  ServiceUpdateFields,
  ServiceVehicleAssignFields,
  ServiceVehicleUnassignFields,
  withWorkspace,
} from "@eci-shuttle/shared";
import { and, eq, gt, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { routes, serviceExceptions, services, serviceVehicles, vehicles } from "@/db/schema";
import type { Service, ServiceException, ServiceVehicle } from "@/db/types";
import { bumpConfigs } from "../devices/config";
import {
  type Actor,
  checkVersion,
  getInWorkspace,
  inWorkspace,
  mutate,
  parseInput,
  readable,
  requireRole,
  ServiceError,
} from "../kernel";

export const CreateServiceInput = withWorkspace(ServiceCreateFields);
export const UpdateServiceInput = withWorkspace(ServiceUpdateFields);
export const AddExceptionInput = withWorkspace(ServiceExceptionFields).superRefine(checkException);
export const RemoveExceptionInput = z.object({ workspaceId: z.uuid(), exceptionId: z.uuid() });
export const AssignServiceVehicleInput = withWorkspace(ServiceVehicleAssignFields);
export const UnassignServiceVehicleInput = withWorkspace(ServiceVehicleUnassignFields);
const DuplicateInput = z.object({
  workspaceId: Id,
  serviceId: Id,
  name: z.string().trim().min(1).max(100),
  validFrom: IsoDate,
  validTo: IsoDate,
});
const ScheduleInput = z.object({ workspaceId: Id, from: IsoDate, days: z.number().int().min(1).max(31) });

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** ISO weekday (1 = Mon … 7 = Sun) of an IST calendar date. */
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const runsOn = (s: Service, d: string) => s.validFrom <= d && d <= s.validTo && s.daysOfWeek.includes(weekday(d));
/** [start, end) of one service day's window, in epoch ms (end < start = runs past midnight). */
function serviceWindow(s: Service, d: string): [number, number] {
  const day = Date.parse(`${d}T00:00:00+05:30`);
  const start = minutes(s.startTime);
  const end = minutes(s.endTime) + (minutes(s.endTime) <= start ? 24 * 60 : 0);
  return [day + start * 60_000, day + end * 60_000];
}
const exceptionDef = (e: ServiceException): ServiceExceptionDef => ({
  serviceId: e.serviceId,
  date: e.date,
  type: e.kind,
  departure: e.departure,
  minutes: e.minutes,
});

function checkRange(validFrom: string, validTo: string) {
  if (validTo < validFrom) throw new ServiceError("INVALID", "The end date is before the start date.");
}

async function checkRoute(tx: Db, workspaceId: string, routeId: string) {
  const route = await getInWorkspace(tx, routes, workspaceId, routeId, "route");
  if (route.archivedAt) throw new ServiceError("INVALID", "That route is archived.");
}

/** Phones of every vehicle staffing the service pick up the new windows. */
async function bumpServiceVehicles(tx: Db, serviceId: string, reason: string) {
  const rows = await tx
    .selectDistinct({ vehicleId: serviceVehicles.vehicleId })
    .from(serviceVehicles)
    .where(eq(serviceVehicles.serviceId, serviceId));
  if (rows.length) await bumpConfigs(tx, { vehicleIds: rows.map((r) => r.vehicleId) }, reason);
}

/** ops+. validTo ≥ validFrom (INVALID). Route must be in the workspace. */
export async function createService(db: Db, actor: Actor, input: z.input<typeof CreateServiceInput>): Promise<Service> {
  const { workspaceId, ...fields } = parseInput(CreateServiceInput, input);
  requireRole(actor, workspaceId, "ops");
  checkRange(fields.validFrom, fields.validTo);
  return mutate(db, actor, { action: "service.create", entity: "service", workspaceId }, async (tx) => {
    await checkRoute(tx, workspaceId, fields.routeId);
    const [row] = await tx
      .insert(services)
      .values({ workspaceId, ...fields })
      .returning();
    return { before: null, after: row, result: row };
  });
}

/** ops+. STALE_VERSION on stale version. Bumps configs of vehicles assigned to it. */
export async function updateService(db: Db, actor: Actor, input: z.input<typeof UpdateServiceInput>): Promise<Service> {
  const { workspaceId, serviceId, version, ...fields } = parseInput(UpdateServiceInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(
    db,
    actor,
    { action: "service.update", entity: "service", entityId: serviceId, workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, services, workspaceId, serviceId, "service", { forUpdate: true });
      checkVersion(before, version, "service");
      checkRange(fields.validFrom ?? before.validFrom, fields.validTo ?? before.validTo);
      if (fields.routeId && fields.routeId !== before.routeId) await checkRoute(tx, workspaceId, fields.routeId);
      const [after] = await tx
        .update(services)
        .set({ ...fields, version: before.version + 1, updatedAt: new Date() })
        .where(eq(services.id, serviceId))
        .returning();
      await bumpServiceVehicles(tx, serviceId, "service.update");
      return { before, after, result: after };
    },
  );
}

/** ops+. "Duplicate as special": a copy with kind special, for one date range, no vehicles. */
export async function duplicateAsSpecial(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; serviceId: string; name: string; validFrom: IsoDate; validTo: IsoDate },
): Promise<Service> {
  const { workspaceId, serviceId, name, validFrom, validTo } = parseInput(DuplicateInput, input);
  requireRole(actor, workspaceId, "ops");
  checkRange(validFrom, validTo);
  return mutate(db, actor, { action: "service.duplicate", entity: "service", workspaceId }, async (tx) => {
    const src = await getInWorkspace(tx, services, workspaceId, serviceId, "service");
    const [row] = await tx
      .insert(services)
      .values({
        workspaceId,
        name,
        kind: "special",
        routeId: src.routeId,
        public: src.public,
        colour: src.colour,
        validFrom,
        validTo,
        daysOfWeek: src.daysOfWeek,
        startTime: src.startTime,
        endTime: src.endTime,
        pattern: src.pattern,
      })
      .returning();
    return { before: null, after: { ...row, duplicatedFrom: serviceId }, result: row };
  });
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
  const { workspaceId, serviceId, date, type, departure, minutes: mins, note } = parseInput(AddExceptionInput, input);
  // cancel_day ignores any departure; normalise once so the dup check matches what we insert
  const dep = type === "cancel_day" ? null : (departure ?? null);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "service.exception", entity: "service_exception", workspaceId }, async (tx) => {
    // the lock serialises concurrent edits of one service, so the duplicate check below can't race
    const service = await getInWorkspace(tx, services, workspaceId, serviceId, "service", { forUpdate: true });
    if (!runsOn(service, date)) throw new ServiceError("INVALID", `${service.name} doesn't run on ${date}.`);
    if (
      (type === "cancel_departure" || type === "shift_minutes") &&
      !expandServiceDepartures(service, [], date).some((d) => d.planned === dep)
    )
      throw new ServiceError("INVALID", `There's no ${departure} departure on ${date}.`);
    const dup = await tx
      .select({ id: serviceExceptions.id })
      .from(serviceExceptions)
      .where(
        and(
          eq(serviceExceptions.serviceId, serviceId),
          eq(serviceExceptions.date, date),
          eq(serviceExceptions.kind, type),
          dep ? eq(serviceExceptions.departure, dep) : isNull(serviceExceptions.departure),
        ),
      )
      .limit(1);
    if (dup.length) throw new ServiceError("CONFLICT", "That edit is already on this day.", { id: dup[0].id });
    const [row] = await tx
      .insert(serviceExceptions)
      .values({
        workspaceId,
        serviceId,
        date,
        kind: type,
        departure: dep,
        minutes: type === "shift_minutes" ? mins : null,
        note,
      })
      .returning();
    await bumpServiceVehicles(tx, serviceId, "service.exception");
    return { before: null, after: row, result: row };
  });
}

/** ops+. Undo a one-day edit. Audited service.exception_remove. */
export async function removeException(
  db: Db,
  actor: Actor,
  input: z.input<typeof RemoveExceptionInput>,
): Promise<void> {
  const { workspaceId, exceptionId } = parseInput(RemoveExceptionInput, input);
  requireRole(actor, workspaceId, "ops");
  await mutate(
    db,
    actor,
    { action: "service.exception_remove", entity: "service_exception", entityId: exceptionId, workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, serviceExceptions, workspaceId, exceptionId, "exception");
      await tx.delete(serviceExceptions).where(eq(serviceExceptions.id, exceptionId));
      await bumpServiceVehicles(tx, before.serviceId, "service.exception_remove");
      return { before, after: null, result: undefined };
    },
  );
}

/**
 * ops+. Vehicle runs the service for [startsAt, endsAt). Overlap with its assignments to other services is allowed
 * (a party run); an overlapping assignment of the same vehicle to the same service is a CONFLICT.
 */
export async function assignServiceVehicle(
  db: Db,
  actor: Actor,
  input: z.input<typeof AssignServiceVehicleInput>,
): Promise<ServiceVehicle> {
  const { workspaceId, serviceId, vehicleId, ...range } = parseInput(AssignServiceVehicleInput, input);
  requireRole(actor, workspaceId, "ops");
  const startsAt = new Date(range.startsAt);
  const endsAt = new Date(range.endsAt);
  if (endsAt <= startsAt) throw new ServiceError("INVALID", "The end time must be after the start time.");
  return mutate(db, actor, { action: "service_vehicle.assign", entity: "service_vehicle", workspaceId }, async (tx) => {
    await getInWorkspace(tx, services, workspaceId, serviceId, "service", { forUpdate: true });
    await getInWorkspace(tx, vehicles, workspaceId, vehicleId, "vehicle");
    const clash = await tx
      .select({ id: serviceVehicles.id })
      .from(serviceVehicles)
      .where(
        and(
          eq(serviceVehicles.serviceId, serviceId),
          eq(serviceVehicles.vehicleId, vehicleId),
          lt(serviceVehicles.startsAt, endsAt),
          gt(serviceVehicles.endsAt, startsAt),
        ),
      )
      .limit(1);
    if (clash.length)
      throw new ServiceError("CONFLICT", "This vehicle is already on this service for part of that time.", {
        id: clash[0].id,
      });
    const [row] = await tx
      .insert(serviceVehicles)
      .values({ workspaceId, serviceId, vehicleId, startsAt, endsAt })
      .returning();
    await bumpConfigs(tx, { vehicleIds: [vehicleId] }, "service_vehicle.assign");
    return { before: null, after: row, result: row };
  });
}

export async function unassignServiceVehicle(
  db: Db,
  actor: Actor,
  input: z.input<typeof UnassignServiceVehicleInput>,
): Promise<void> {
  const { workspaceId, serviceVehicleId } = parseInput(UnassignServiceVehicleInput, input);
  requireRole(actor, workspaceId, "ops");
  await mutate(
    db,
    actor,
    { action: "service_vehicle.unassign", entity: "service_vehicle", entityId: serviceVehicleId, workspaceId },
    async (tx) => {
      const before = await getInWorkspace(tx, serviceVehicles, workspaceId, serviceVehicleId, "assignment");
      await tx.delete(serviceVehicles).where(eq(serviceVehicles.id, serviceVehicleId));
      await bumpConfigs(tx, { vehicleIds: [before.vehicleId] }, "service_vehicle.unassign");
      return { before, after: null, result: undefined };
    },
  );
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
  const { workspaceId, from, days } = parseInput(ScheduleInput, input);
  readable(actor, workspaceId);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const last = dates[dates.length - 1];
  const svcs = await db
    .select()
    .from(services)
    .where(
      and(
        inWorkspace(services, workspaceId),
        isNull(services.archivedAt),
        lte(services.validFrom, last),
        gte(services.validTo, from),
      ),
    )
    .orderBy(services.startTime, services.name);
  const ids = svcs.map((s) => s.id);
  const [exs, svs] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(serviceExceptions)
          .where(
            and(
              inArray(serviceExceptions.serviceId, ids),
              gte(serviceExceptions.date, from),
              lte(serviceExceptions.date, last),
            ),
          ),
        db
          .select()
          .from(serviceVehicles)
          .where(
            and(
              inArray(serviceVehicles.serviceId, ids),
              lt(serviceVehicles.startsAt, new Date(Date.parse(`${addDays(last, 2)}T00:00:00+05:30`))),
              gt(serviceVehicles.endsAt, new Date(Date.parse(`${from}T00:00:00+05:30`))),
            ),
          )
          .orderBy(serviceVehicles.startsAt),
      ])
    : [[], []];

  return dates.map((date) => ({
    date,
    services: svcs
      .filter((s) => runsOn(s, date))
      .map((service) => {
        const exceptions = exs.filter((e) => e.serviceId === service.id && e.date === date);
        const [start, end] = serviceWindow(service, date);
        return {
          service,
          exceptions,
          vehicles: svs.filter(
            (v) => v.serviceId === service.id && v.startsAt.getTime() < end && v.endsAt.getTime() > start,
          ),
          departures: expandServiceDepartures(service, exceptions.map(exceptionDef), date),
        };
      }),
  }));
}
