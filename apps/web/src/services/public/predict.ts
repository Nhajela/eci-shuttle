/**
 * svc-public: pure helpers for "predicted" sight (sight.ts): the distances along a route that PredictRoute needs,
 * and where a given distance is on the map.
 */
import { type LatLng, pathLengthM } from "@eci-shuttle/shared";
import type { DeadZone } from "../signal/dead-zones";
import type { PredictRoute } from "./sight";

type RouteGeo = { spotIds: string[]; spotPathIdx: number[]; path: LatLng[] };

/** Metres along the path of every spot of the route; null when the path is not indexed to the spots. */
export function spotAlongM(route: RouteGeo): number[] | null {
  const { path, spotPathIdx: idx, spotIds } = route;
  if (path.length < 2 || idx.length !== spotIds.length) return null;
  const out: number[] = [];
  let m = 0;
  let at = 0;
  for (const i of idx) {
    const to = Math.min(path.length - 1, Math.max(at, i));
    m += pathLengthM(path.slice(at, to + 1));
    at = to;
    out.push(m);
  }
  return out;
}

/**
 * The PredictRoute of a route, or null when it has no dead zone (so nothing is predicted and nothing is computed).
 * `legS` are the caller's leg estimates in seconds (null = none); a leg without one uses the route's learned
 * `typicalLegS`, else stays null (no guess is made without a time).
 */
export function predictRoute(
  route: RouteGeo & { id: string; typicalLegS: (number | null)[] },
  zones: DeadZone[],
  legS: (number | null)[],
): PredictRoute | null {
  const mine = zones.filter((z) => z.routeId === route.id);
  if (!mine.length) return null;
  const along = spotAlongM(route);
  if (!along) return null;
  return {
    routeId: route.id,
    spotIds: route.spotIds,
    spotAlongM: along,
    legS: route.spotIds.slice(1).map((_, i) => legS[i] ?? route.typicalLegS[i] ?? null),
    zones: mine,
    spotPathIdx: route.spotPathIdx,
    path: route.path,
    legPaths: route.spotIds.slice(1).map((_, i) => {
      const a = route.spotPathIdx[i];
      const b = route.spotPathIdx[i + 1];
      return a === undefined || b === undefined ? null : route.path.slice(a, b + 1);
    }),
  };
}

/** The point `alongM` metres along the path (clamped to its ends); null for an empty path. */
export function pointAtAlong(path: LatLng[], alongM: number): LatLng | null {
  const first = path[0];
  if (!first) return null;
  let left = Math.max(0, alongM);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as LatLng;
    const b = path[i + 1] as LatLng;
    const seg = pathLengthM([a, b]);
    if (seg > 0 && left <= seg) {
      const t = left / seg;
      return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
    }
    left -= seg;
  }
  return path.at(-1) ?? first;
}
