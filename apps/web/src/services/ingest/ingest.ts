/**
 * svc-ingest: pings → vehicle_state, dwells, trips, departure_matches (SPEC §3, §6a pipeline). Derived data: not
 * audited. Called by devices/sync inside its transaction.
 */
import { notImplemented, type Ping } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { Trip, VehicleState } from "@/db/types";

export type IngestResult = {
  /** pings stored (duplicates on (device_id, recorded_at) skipped) */
  inserted: number;
  /** trips closed by this batch: the caller passes them to learning.onTripClosed */
  closedTrips: Trip[];
  /** vehicles whose state changed: the caller checks arrival alerts for them */
  vehicleIds: string[];
};

/**
 * Store pings (resolving vehicle_id from the device's assignment at each recorded_at), then, for the assigned
 * vehicle, in recorded_at order: geofenceStep (shared-geo) per fix → dwells (arrived/departed), trips
 * (from → to spot, quality clean / gap (> 2 min without fixes) / off_route (> 150 m off the path for > 1 min)),
 * departure_matches for the service running (matchDepartures on that day's planned vs actual departures),
 * vehicle_state (phase, spot / next spot, eta_s via etaToSpot, last_ping_at, off_route, geofence state).
 * Pings older than the vehicle's last processed fix are stored but don't rewind state.
 */
export async function ingestPings(
  db: Db,
  input: { workspaceId: string; deviceId: string; pings: Ping[] },
  now: Date,
): Promise<IngestResult> {
  return notImplemented(db, input, now);
}

/**
 * Mark vehicles offline (phase "offline") whose last ping is > 2 min old while inside a tracking window, and
 * "off_duty" outside windows. Called by the watchdog/windows jobs. Returns vehicles changed.
 */
export async function refreshPhases(db: Db, workspaceId: string, now: Date): Promise<string[]> {
  return notImplemented(db, workspaceId, now);
}

/** All vehicle_state rows of a workspace (live board, public status). No actor: callers check access. */
export async function vehicleStates(db: Db, workspaceId: string): Promise<VehicleState[]> {
  return notImplemented(db, workspaceId);
}
