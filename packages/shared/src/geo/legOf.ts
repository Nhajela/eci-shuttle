import type { LatLng } from "../contracts";
import { distanceM } from "./path";

/**
 * Which leg or stop of a route a vehicle is on, when the route repeats stops (an out-and-back route lists Riva,
 * Circle and a loop's first spot twice: Nanu → Riva → Circle → Namaka → Circle → Riva → Nanu). `indexOf` on spot
 * ids always answers the FIRST occurrence, which puts every vehicle on the way back onto the way out.
 *
 * Leg k runs spotIds[k] → spotIds[k + 1]. All functions are pure. The geometry (spotPathIdx, path) is optional:
 * without it only the spot ids disambiguate.
 */
export type LegRoute = { spotIds: string[]; spotPathIdx?: number[]; path?: LatLng[] };

export type LegHint = {
  /** the stop the vehicle is at, or the stop it left */
  spotId?: string | null;
  /** the stop it is heading for */
  nextSpotId?: string | null;
  /** metres along the whole route path (vehicle_state.alongM) */
  alongM?: number | null;
};

export type SpotHint = {
  /** the stop after this one (vehicle_state.nextSpotId); null = none (the end of a one-way route) */
  nextSpotId?: string | null;
  alongM?: number | null;
  /**
   * The stops the vehicle visited most recently, oldest first, consecutive repeats collapsed (the dwell log).
   * Ignored unless the last one is the spot itself.
   */
  recent?: string[];
};

/** Metres along the route path at each spot (same length as spotIds); null when the geometry does not line up. */
export function spotAlongM(route: LegRoute): number[] | null {
  const { spotIds, spotPathIdx: idx, path } = route;
  if (!idx || !path || path.length < 2 || idx.length !== spotIds.length) return null;
  const cum = [0];
  for (let i = 1; i < path.length; i++)
    cum[i] = (cum[i - 1] as number) + distanceM(path[i - 1] as LatLng, path[i] as LatLng);
  const out: number[] = [];
  for (const i of idx) {
    const m = cum[i];
    if (m === undefined) return null;
    out.push(m);
  }
  return out;
}

const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);
const isLoop = (ids: string[]) => ids.length > 2 && ids[0] === ids[ids.length - 1];

/**
 * The leg (index k into spotIds, leg = spotIds[k] → spotIds[k + 1]) a vehicle is on, or -1 when the hint names a
 * spot that is not on the route (or the route has no legs). Pure.
 *
 * - spotId + nextSpotId name the leg; the pair is almost always unique even when each stop repeats.
 * - A pair that matches no leg falls back to nextSpotId alone (where it is heading), then spotId alone.
 * - Still several legs → the one whose span along the path holds alongM (nearest span when it is outside all).
 * - Nothing disambiguates (no alongM, no geometry) → the first occurrence, as `indexOf` would.
 * - A loop's last spot is its first: leaving it is leg 0 again (spotId nanu, nextSpotId riva → 0).
 */
export function legOf(route: LegRoute, hint: LegHint = {}): number {
  const ids = route.spotIds;
  const legs = range(ids.length - 1);
  const { spotId, nextSpotId, alongM } = hint;
  const from = spotId ? legs.filter((k) => ids[k] === spotId) : legs;
  const to = nextSpotId ? legs.filter((k) => ids[k + 1] === nextSpotId) : legs;
  let pool = from.filter((k) => to.includes(k));
  if (!pool.length) pool = nextSpotId && to.length ? to : spotId && from.length ? from : [];
  if (!pool.length && !spotId && !nextSpotId) pool = legs;
  return pickByAlong(route, pool, alongM, (k) => [k, k + 1]) ?? -1;
}

/** Among candidate indices, the one whose [start, end] span (spot indices, via `span`) holds alongM. */
function pickByAlong(
  route: LegRoute,
  pool: number[],
  alongM: number | null | undefined,
  span: (k: number) => [number, number],
): number | undefined {
  if (pool.length < 2 || alongM == null || !Number.isFinite(alongM)) return pool[0];
  const m = spotAlongM(route);
  if (!m) return pool[0];
  let best = pool[0] as number;
  let bestD = Number.POSITIVE_INFINITY;
  for (const k of pool) {
    const [a, b] = span(k);
    const lo = m[a] as number;
    const hi = m[b] as number;
    const d = alongM < lo ? lo - alongM : alongM > hi ? alongM - hi : 0;
    if (d < bestD - 1e-9) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/** How many of the latest visits agree with the route read backwards from occurrence j (a loop wraps around). */
function suffixMatch(ids: string[], j: number, recent: string[]): number {
  const loop = isLoop(ids);
  const period = ids.length - 1;
  let m = 0;
  for (; m < recent.length; m++) {
    let i = j - m;
    if (i < 0) {
      if (!loop) break;
      i = ((i % period) + period) % period;
    }
    if (ids[i] !== recent[recent.length - 1 - m]) break;
  }
  return m;
}

/**
 * Every occurrence (index into spotIds) of `spotId` the hint leaves open, narrowed by, in order: the dwell history
 * (longest agreement with the route), the stop it heads for next, and alongM (nearest occurrence). [] when the
 * spot is not on the route. Pure.
 */
export function spotCandidates(route: LegRoute, spotId: string, hint: SpotHint = {}): number[] {
  const ids = route.spotIds;
  let pool = range(ids.length).filter((i) => ids[i] === spotId);
  if (pool.length < 2) return pool;

  const recent = hint.recent?.at(-1) === spotId ? hint.recent : undefined;
  if (recent) {
    const score = pool.map((j) => suffixMatch(ids, j, recent));
    const top = Math.max(...score);
    pool = pool.filter((_, n) => score[n] === top);
    // a loop's last spot is its first: same place, same next leg
    if (isLoop(ids) && pool.length > 1 && pool.every((j) => j === 0 || j === ids.length - 1)) return [0];
  }
  if (pool.length > 1 && hint.nextSpotId !== undefined) {
    const next = pool.filter((i) => (hint.nextSpotId === null ? i === ids.length - 1 : ids[i + 1] === hint.nextSpotId));
    if (next.length) pool = next;
  }
  if (pool.length > 1 && hint.alongM != null) {
    const m = spotAlongM(route);
    if (m) {
      let bestD = Number.POSITIVE_INFINITY;
      let best = pool;
      for (const i of pool) {
        const d = Math.abs((m[i] as number) - (hint.alongM as number));
        if (d < bestD - 1e-9) {
          bestD = d;
          best = [i];
        }
      }
      pool = best;
    }
  }
  return pool;
}

/** The occurrence of `spotId` the hint points to (the first when nothing disambiguates); -1 when not on the route. */
export function spotIndexOf(route: LegRoute, spotId: string, hint: SpotHint = {}): number {
  return spotCandidates(route, spotId, hint)[0] ?? -1;
}
