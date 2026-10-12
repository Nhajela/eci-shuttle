import type { LatLng, PathProjection } from "../contracts";
import { notImplemented } from "../notImplemented";

/**
 * Project a point onto a polyline (the route path). Pure.
 *
 * - Distances are metres on a local equirectangular approximation (fine at shuttle scale, a few km).
 * - Picks the segment with the smallest perpendicular distance; ties go to the earlier segment, so a loop path
 *   that passes the same street twice resolves to the first pass (callers pass a leg's sub-path to disambiguate).
 * - alongM = length of all earlier segments + distance along the chosen segment to the foot of the perpendicular,
 *   clamped to that segment's ends. offsetM = distance from the point to that foot.
 * - Path of one point: alongM 0, segmentIndex 0, totalM 0. Empty path throws.
 * - Zero-length segments (repeated points) are skipped without dividing by zero.
 */
export function projectOntoPath(path: LatLng[], point: LatLng): PathProjection {
  return notImplemented(path, point);
}

/** Great-circle (haversine) distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  return notImplemented(a, b);
}

/** Total length of a polyline in metres. */
export function pathLengthM(path: LatLng[]): number {
  return notImplemented(path);
}
