import type { LatLng, PathProjection } from "../contracts";

const R = 6_371_000;
const RAD = Math.PI / 180;

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
  const first = path[0];
  if (!first) throw new Error("projectOntoPath: empty path");
  // local planar metres around the point
  const kx = R * RAD * Math.cos(point.lat * RAD);
  const ky = R * RAD;
  const xy = (q: LatLng) => [(q.lng - point.lng) * kx, (q.lat - point.lat) * ky] as const;

  let best = { alongM: 0, offsetM: distanceM(point, first), segmentIndex: 0, point: first };
  let bestPlanar = Math.hypot(...xy(first));
  let before = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as LatLng;
    const b = path[i + 1] as LatLng;
    const segM = distanceM(a, b);
    const [ax, ay] = xy(a);
    const [bx, by] = xy(b);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const planar = Math.hypot(ax + t * dx, ay + t * dy);
      if (planar < bestPlanar - 1e-9) {
        const foot = t === 0 ? a : t === 1 ? b : { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
        bestPlanar = planar;
        best = { alongM: before + t * segM, offsetM: distanceM(point, foot), segmentIndex: i, point: foot };
      }
    }
    before += segM;
  }
  return { ...best, totalM: before };
}

/** Great-circle (haversine) distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const h =
    Math.sin(((b.lat - a.lat) * RAD) / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(((b.lng - a.lng) * RAD) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline in metres. */
export function pathLengthM(path: LatLng[]): number {
  let m = 0;
  for (let i = 0; i + 1 < path.length; i++) m += distanceM(path[i] as LatLng, path[i + 1] as LatLng);
  return m;
}
