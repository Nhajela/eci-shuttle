/** Types for the pure schedule functions in src/schedule (owned by shared-schedule). Times are epoch ms; days are IST. */
import type { EpochMs, HHMM, Id, IsoDate, Weekday } from "./common";
import type { ExceptionKind, ServiceKind } from "./enums";
import type { ServicePattern } from "./inputs";

/** The subset of a `services` row the schedule maths needs. */
export type ServiceDef = {
  id: Id;
  kind: ServiceKind;
  routeId: Id;
  public: boolean;
  validFrom: IsoDate;
  validTo: IsoDate;
  daysOfWeek: Weekday[];
  startTime: HHMM;
  endTime: HHMM;
  pattern: ServicePattern;
};

export type ServiceExceptionDef = {
  serviceId: Id;
  date: IsoDate;
  type: ExceptionKind;
  departure: HHMM | null;
  minutes: number | null;
};

export type ServiceVehicleDef = {
  id: Id;
  serviceId: Id;
  vehicleId: Id;
  startsAt: EpochMs;
  endsAt: EpochMs;
};

/** One planned departure from the route's first spot on one service day, after exceptions. */
export type Departure = {
  serviceId: Id;
  /** the IST service day it belongs to (a 01:00 departure of a 22:00–02:00 service belongs to the previous date) */
  date: IsoDate;
  at: EpochMs;
  /** the pattern time before any shift ("HH:MM"); for added departures, the added time */
  planned: HHMM;
  shiftedMin: number;
  added: boolean;
};

/** When a vehicle should be tracking: service windows ±pad, intersected with its assignment, merged per vehicle. */
export type VehicleWindow = {
  vehicleId: Id;
  startsAt: EpochMs;
  endsAt: EpochMs;
  /** services that produced this (merged) window */
  serviceIds: Id[];
};

export type PlannedDeparture = { id: string; at: EpochMs };
export type ActualDeparture = { id: string; at: EpochMs };

export type DepartureMatch = {
  plannedId: string;
  actualId: string | null;
  /** actual − planned in minutes (negative = early); null when missed */
  delayMin: number | null;
  missed: boolean;
};

export type MatchResult = {
  /** one entry per planned departure, in planned time order */
  matches: DepartureMatch[];
  /** actual departures that matched nothing (extra runs) */
  unmatchedActualIds: string[];
};
