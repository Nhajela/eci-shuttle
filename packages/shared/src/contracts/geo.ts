/** Types for the pure geo/ETA functions in src/geo (owned by shared-geo). Distances in metres, times epoch ms. */
import type { EpochMs, Id, LatLng } from "./common";
import type { EstimateLevel } from "./enums";

export type PathProjection = {
  /** distance along the path from its start to the projected point */
  alongM: number;
  /** perpendicular distance from the point to the path (off-route detection) */
  offsetM: number;
  /** index i of the segment path[i] → path[i+1] the point projects onto */
  segmentIndex: number;
  totalM: number;
  /** the projected point on the path */
  point: LatLng;
};

export type Fix = { at: EpochMs; lat: number; lng: number; accuracy: number };

export type GeofenceSpot = { id: Id; lat: number; lng: number; radiusM: number };

/** Persisted per vehicle in vehicle_state.geofence. */
export type GeofenceState = {
  /** the spot the vehicle is confirmed inside, or null */
  insideSpotId: Id | null;
  /** when it was first seen inside insideSpotId (start of the 20 s dwell), i.e. the arrival time */
  enteredAt: EpochMs | null;
  /** a spot the vehicle is inside but hasn't dwelt 20 s in yet */
  candidateSpotId: Id | null;
  candidateSince: EpochMs | null;
  lastFixAt: EpochMs | null;
};

export const INITIAL_GEOFENCE_STATE: GeofenceState = {
  insideSpotId: null,
  enteredAt: null,
  candidateSpotId: null,
  candidateSince: null,
  lastFixAt: null,
};

export type GeofenceEvent = { kind: "arrived" | "departed"; spotId: Id; at: EpochMs };

export type GeofenceStepResult = { state: GeofenceState; events: GeofenceEvent[] };

/** A finished trip leg or dwell duration used for learning. */
export type LegSample = {
  durationS: number;
  /** when the leg started (departed_at) or dwell started (arrived_at) */
  at: EpochMs;
};

export type LegEstimateOptions = {
  /** IST hour 0..23 the estimate is for */
  hourBucket: number;
  /** path length of the leg, for the baseline rung; 0 for dwells */
  pathM: number;
  now: EpochMs;
  /** default 25 km/h (day-1 baseline) */
  baselineKmh?: number;
  /** default 5: below this the estimate is "thin" (UI says about/estimate) */
  minSamples?: number;
  /** default 7 service days of history */
  windowDays?: number;
  /** baseline dwell in seconds when there are no samples at all (dwells have pathM 0); default 180 */
  baselineDwellS?: number;
};

export type LegEstimate = {
  medianS: number;
  p20S: number;
  p80S: number;
  n: number;
  level: EstimateLevel;
  /** n < minSamples */
  thin: boolean;
};

/** A route leg s[i] → s[i+1] with what is known about it. */
export type EtaLeg = {
  fromSpotId: Id;
  toSpotId: Id;
  lengthM: number;
  estimate: LegEstimate;
  /** optional per-segment median speeds along this leg (~200 m segments), offsets relative to the leg start */
  segments?: { startM: number; endM: number; medianMps: number }[];
};

export type EtaVehicle =
  | { kind: "en_route"; legIndex: number; alongLegM: number }
  | { kind: "at_spot"; spotIndex: number; since: EpochMs };

export type EtaInput = {
  /** the route's legs in order (spotIds[i] → spotIds[i+1]) */
  legs: EtaLeg[];
  /** learned dwell per spot id */
  dwells: Record<Id, LegEstimate>;
  vehicle: EtaVehicle;
  targetSpotId: Id;
  /** wrap from the last leg back to the first (continuous loop / a vehicle that runs the route again) */
  loop: boolean;
  now: EpochMs;
};

export type EtaResult = {
  seconds: number;
  minutes: number;
  /** p20..p80 range in whole minutes */
  lo: number;
  hi: number;
  /** "learned" when every estimate used has n >= minSamples above the baseline rung; else "estimate" (UI: "about") */
  basis: "learned" | "estimate";
  /** how many legs were chained to reach the target (0 = vehicle is at the target) */
  legsChained: number;
};
