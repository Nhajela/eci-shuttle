/** svc-public: pure geometry for the public map (heading along a route path, progress along a leg). */
import { type LatLng, pathLengthM } from "@eci-shuttle/shared";

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Compass bearing in degrees (0 = north, 90 = east) from `a` to `b`. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * The bearing of the path segment `alongM` metres from its start (clamped to the first / last segment).
 * Null when the path has fewer than two points.
 */
export function headingAlongPath(path: LatLng[], alongM: number): number | null {
  if (path.length < 2) return null;
  let left = Math.max(0, alongM);
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i] as LatLng;
    const b = path[i + 1] as LatLng;
    const seg = pathLengthM([a, b]);
    if (left <= seg || i === path.length - 2) return bearingDeg(a, b);
    left -= seg;
  }
  return null;
}

export type LegRoute = { path: LatLng[]; spotPathIdx: number[]; spotIds: string[] };

/** 0..1: how far along leg `legIndex` (between spots legIndex and legIndex+1) a vehicle `alongM` metres into the route is. */
export function legFraction(route: LegRoute, legIndex: number, alongM: number | null): number | null {
  if (alongM === null) return null;
  const { path, spotPathIdx: idx } = route;
  if (path.length < 2 || idx.length !== route.spotIds.length || legIndex < 0 || legIndex >= idx.length - 1) return null;
  const start = pathLengthM(path.slice(0, (idx[legIndex] as number) + 1));
  const end = pathLengthM(path.slice(0, (idx[legIndex + 1] as number) + 1));
  if (end <= start) return null;
  return Math.min(1, Math.max(0, (alongM - start) / (end - start)));
}
