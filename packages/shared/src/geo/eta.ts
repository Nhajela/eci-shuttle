import type { EtaInput, EtaLeg, EtaResult, LegEstimate } from "../contracts";

/** Same as legEstimate's baseline rung for a dwell with no samples (baselineDwellS default). */
const BASELINE_DWELL: LegEstimate = { medianS: 180, p20S: 180, p80S: 180, n: 0, level: "baseline", thin: true };

type Sum = { med: number; lo: number; hi: number; thin: boolean };

/** Time for the part of a leg from alongM to its end: segment speeds where they cover it, else the scaled estimate. */
function restOfLeg(leg: EtaLeg, alongM: number): Sum {
  const { estimate: e, lengthM } = leg;
  const from = Math.min(Math.max(0, alongM), lengthM);
  let segS = 0;
  let coveredM = 0;
  for (const s of leg.segments ?? []) {
    const m = Math.min(s.endM, lengthM) - Math.max(s.startM, from);
    if (m > 0 && s.medianMps > 0) {
      segS += m / s.medianMps;
      coveredM += m;
    }
  }
  const frac = lengthM > 0 ? Math.max(0, lengthM - from - coveredM) / lengthM : 0;
  // segments only carry a median, so their p20/p80 borrow the leg estimate's spread
  const lo = e.medianS > 0 ? e.p20S / e.medianS : 1;
  const hi = e.medianS > 0 ? e.p80S / e.medianS : 1;
  return { med: segS + e.medianS * frac, lo: segS * lo + e.p20S * frac, hi: segS * hi + e.p80S * frac, thin: e.thin };
}

/**
 * Predicted time until the vehicle is at `targetSpotId` (SPEC §6a.1–2). Pure. Returns null when the target is
 * not on the route ahead (and `loop` is false), or the input is inconsistent (legIndex out of range).
 *
 * - en_route on leg i at alongLegM: the rest of leg i is time over the remaining metres, from `segments` speeds
 *   where they cover it, else the leg's estimate scaled by remainingM / lengthM. Then, until the target spot:
 *   for each spot passed, its dwell estimate; for each following leg, its estimate. Chains legs (SPEC §6a.2).
 * - at_spot k since t: if spot k is the target → 0 s, legsChained 0. Else the remaining dwell
 *   max(0, dwell.medianS − (now − since)) then legs from k onward as above.
 * - loop: after the last leg continue from leg 0 (at most one full lap). Not loop: stop at the last spot.
 * - The same spot can appear twice on a route (Riva → Circle → Riva): the next occurrence ahead is the target.
 * - seconds uses medians; lo / hi sum p20 / p80 likewise (scaled the same way for the partial leg), all rounded
 *   to whole minutes (minutes = round(seconds / 60), lo ≤ minutes ≤ hi).
 * - basis "learned" only if every estimate used is not thin; else "estimate" (the UI says "about").
 * - Never adds lateness relative to the timetable: this is purely predictive.
 */
export function etaToSpot(input: EtaInput): EtaResult | null {
  const { legs, dwells, vehicle, targetSpotId, loop, now } = input;
  const n = legs.length;
  const legAt = (i: number) => legs[i] as EtaLeg; // indices are range-checked below
  const dwellOf = (spotId: string) => dwells[spotId] ?? BASELINE_DWELL;

  let sum: Sum;
  let legIdx: number; // the leg the vehicle is on / about to start
  if (vehicle.kind === "en_route") {
    legIdx = vehicle.legIndex;
    if (!Number.isInteger(legIdx) || legIdx < 0 || legIdx >= n) return null;
    sum = restOfLeg(legAt(legIdx), vehicle.alongLegM);
  } else {
    const k = vehicle.spotIndex;
    if (!Number.isInteger(k) || k < 0 || k > n || n === 0) return null;
    const spotId = k < n ? legAt(k).fromSpotId : legAt(n - 1).toSpotId;
    if (spotId === targetSpotId) return { seconds: 0, minutes: 0, lo: 0, hi: 0, basis: "learned", legsChained: 0 };
    if (k === n && !loop) return null;
    const d = dwellOf(spotId);
    const elapsedS = Math.max(0, (now - vehicle.since) / 1000);
    sum = { med: 0, lo: 0, hi: 0, thin: false };
    add(sum, {
      med: Math.max(0, d.medianS - elapsedS),
      lo: Math.max(0, d.p20S - elapsedS),
      hi: Math.max(0, d.p80S - elapsedS),
      thin: d.thin,
    });
    legIdx = k % n;
    add(sum, restOfLeg(legAt(legIdx), 0));
  }

  // sum covers legs up to and including legIdx; walk spot by spot until the target, at most one lap
  for (let chained = 1; ; chained++) {
    const arrived = legAt(legIdx).toSpotId;
    if (arrived === targetSpotId) return result(sum, chained);
    if (chained >= n || (legIdx === n - 1 && !loop)) return null;
    const d = dwellOf(arrived);
    add(sum, { med: d.medianS, lo: d.p20S, hi: d.p80S, thin: d.thin });
    legIdx = (legIdx + 1) % n;
    add(sum, restOfLeg(legAt(legIdx), 0));
  }
}

function add(into: Sum, x: Sum) {
  into.med += x.med;
  into.lo += x.lo;
  into.hi += x.hi;
  into.thin ||= x.thin;
}

function result(s: Sum, legsChained: number): EtaResult {
  const minutes = Math.round(s.med / 60);
  return {
    seconds: Math.round(s.med),
    minutes,
    lo: Math.min(minutes, Math.round(s.lo / 60)),
    hi: Math.max(minutes, Math.round(s.hi / 60)),
    basis: s.thin ? "estimate" : "learned",
    legsChained,
  };
}
