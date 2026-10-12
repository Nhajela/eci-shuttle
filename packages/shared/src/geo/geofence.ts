import type { Fix, GeofenceSpot, GeofenceState, GeofenceStepResult } from "../contracts";
import { notImplemented } from "../notImplemented";

/** Seconds a vehicle must stay inside a spot's radius before it counts as arrived. */
export const GEOFENCE_DWELL_S = 20;
/** A vehicle leaves a spot only when it is beyond radius × this (hysteresis). */
export const GEOFENCE_EXIT_FACTOR = 1.5;
/** Fixes worse than this are ignored entirely. */
export const GEOFENCE_MAX_ACCURACY_M = 100;

/**
 * Advance one vehicle's geofence state machine by one fix. Pure; fixes must be fed in recordedAt order.
 *
 * - fix.accuracy > 100 m → ignored: state unchanged (not even lastFixAt), no events.
 * - A fix older than or equal to state.lastFixAt → ignored (duplicates / out-of-order uploads).
 * - Not inside any spot: when the fix is within a spot's radiusM it becomes the candidate (candidateSince = fix.at);
 *   when a later fix is still within that radius and fix.at − candidateSince ≥ 20 s → `arrived` (at = candidateSince),
 *   insideSpotId set, enteredAt = candidateSince. Leaving the radius before 20 s clears the candidate (no event).
 * - Overlapping spots: the nearest spot centre wins.
 * - Inside a spot: stays inside while within radiusM × 1.5; the first fix beyond that → `departed` (at = fix.at),
 *   insideSpotId cleared. The same fix may start a candidacy for another spot.
 * - A spot missing from `spots` (archived) while inside → `departed` at fix.at.
 */
export function geofenceStep(state: GeofenceState, fix: Fix, spots: GeofenceSpot[]): GeofenceStepResult {
  return notImplemented(state, fix, spots);
}
