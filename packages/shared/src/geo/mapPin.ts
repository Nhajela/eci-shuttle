import type { LatLng } from "../contracts";

/** A vehicle whose last fix is older than this gets no map pin: a frozen pin reads as "parked here". */
export const MAP_PIN_MAX_AGE_MS = 15 * 60_000;

/** Where to pin a vehicle on a staff map, or null when it has no position or the fix is too old. */
export function mapPin(
  state: { lat: number | null; lng: number | null; lastPingAt: Date | null } | undefined,
  now: number,
): LatLng | null {
  if (state?.lat == null || state.lng == null || !state.lastPingAt) return null;
  return now - state.lastPingAt.getTime() > MAP_PIN_MAX_AGE_MS ? null : { lat: state.lat, lng: state.lng };
}
