/** The replay plan: a route turned into an endless cycle of "dwell at a spot, drive the leg". Pure. */
import { distanceM, type LatLng } from "@eci-shuttle/shared";

/** One point = a dwell; more = a drive along the points. */
type Step = { pts: LatLng[]; cum: number[]; durS: number };
export type Plan = { steps: Step[]; totalS: number };
export type Position = LatLng & { speedMps: number; heading: number | null };

/** start/end closer than this = a loop route (Riva → Circle → Riva), replayed forward forever */
const CLOSED_M = 50;

const step = (pts: LatLng[], durS: number): Step => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distanceM(pts[i - 1], pts[i]));
  return { pts, cum, durS };
};

/**
 * Dwell `dwellS` at each spot, then drive each leg in its learned time (typicalLegS) or at `kmh`.
 * A route that doesn't end where it starts is driven back the same way, so the cycle never teleports.
 */
export function buildPlan(
  route: { path: LatLng[]; spotPathIdx: number[]; typicalLegS: number[] },
  opts: { dwellS: number; kmh: number },
): Plan {
  const { path } = route;
  if (path.length < 2) throw new Error("The route has no path to drive: open it in admin and save its path.");
  const idx = route.spotPathIdx.length >= 2 ? route.spotPathIdx : [0, path.length - 1];
  const mps = opts.kmh / 3.6;
  const legs: Step[] = [];
  for (let k = 0; k < idx.length - 1; k++) {
    const s = step(path.slice(idx[k], idx[k + 1] + 1), 0);
    s.durS = route.typicalLegS[k] > 0 ? route.typicalLegS[k] : s.cum[s.cum.length - 1] / mps;
    legs.push(s);
  }
  if (distanceM(path[idx[0]], path[idx[idx.length - 1]]) >= CLOSED_M)
    for (let k = idx.length - 2; k >= 0; k--) {
      const s = step(path.slice(idx[k], idx[k + 1] + 1).reverse(), 0);
      s.durS = s.cum[s.cum.length - 1] / mps;
      legs.push(s);
    }
  const steps = legs.flatMap((l) => [step([l.pts[0]], opts.dwellS), l]);
  return { steps, totalS: steps.reduce((t, s) => t + s.durS, 0) };
}

/** Where the vehicle is `tS` seconds into the replay (cycles forever). speedMps is in plan time. */
export function positionAt(plan: Plan, tS: number): Position {
  let t = ((tS % plan.totalS) + plan.totalS) % plan.totalS;
  for (const s of plan.steps) {
    if (t >= s.durS) {
      t -= s.durS;
      continue;
    }
    if (s.pts.length === 1) return { ...s.pts[0], speedMps: 0, heading: null };
    const len = s.cum[s.cum.length - 1];
    const d = (t / s.durS) * len;
    let i = 1;
    while (i < s.cum.length - 1 && s.cum[i] < d) i++;
    const a = s.pts[i - 1];
    const b = s.pts[i];
    const seg = s.cum[i] - s.cum[i - 1];
    const f = seg > 0 ? (d - s.cum[i - 1]) / seg : 0;
    const heading = (Math.atan2((b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lng: a.lng + (b.lng - a.lng) * f,
      speedMps: len / s.durS,
      heading: (heading + 360) % 360,
    };
  }
  const s = plan.steps[plan.steps.length - 1];
  const last = s.pts[s.pts.length - 1];
  return { ...last, speedMps: 0, heading: null };
}
