import type { Fix, GeofenceEvent, GeofenceSpot, GeofenceState, GeofenceStepResult } from "../contracts";

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
  if (fix.accuracy > GEOFENCE_MAX_ACCURACY_M) return { state, events: [] };
  if (state.lastFixAt !== null && fix.at <= state.lastFixAt) return { state, events: [] };

  const events: GeofenceEvent[] = [];
  const next: GeofenceState = { ...state, lastFixAt: fix.at };

  if (next.insideSpotId !== null) {
    const spot = spots.find((s) => s.id === next.insideSpotId);
    if (spot && haversineM(fix, spot) <= spot.radiusM * GEOFENCE_EXIT_FACTOR) return { state: next, events };
    events.push({ kind: "departed", spotId: next.insideSpotId, at: fix.at });
    next.insideSpotId = null;
    next.enteredAt = null;
  }

  let nearest: GeofenceSpot | null = null;
  let nearestM = Number.POSITIVE_INFINITY;
  for (const spot of spots) {
    const d = haversineM(fix, spot);
    if (d <= spot.radiusM && d < nearestM) {
      nearest = spot;
      nearestM = d;
    }
  }

  if (!nearest) {
    next.candidateSpotId = null;
    next.candidateSince = null;
  } else if (nearest.id !== next.candidateSpotId || next.candidateSince === null) {
    next.candidateSpotId = nearest.id;
    next.candidateSince = fix.at;
  } else if (fix.at - next.candidateSince >= GEOFENCE_DWELL_S * 1000) {
    events.push({ kind: "arrived", spotId: nearest.id, at: next.candidateSince });
    next.insideSpotId = nearest.id;
    next.enteredAt = next.candidateSince;
    next.candidateSpotId = null;
    next.candidateSince = null;
  }
  return { state: next, events };
}

// ponytail: local haversine because path.distanceM is still a stub owned by another task; switch to it once it lands.
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
