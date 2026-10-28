/**
 * svc-public: the travel time of each leg of a route, the one place it is decided (status.ts for the ETA, positions.ts
 * and estimates.ts for the estimated van): learned for this hour → learned all day → the route's typical time → the
 * leg's length at 25 km/h. Pure, so the answer, the map and the expiry of a prediction always agree.
 */
import { type EtaLeg, type LegEstimate, pathLengthM } from "@eci-shuttle/shared";
import type { LegStat, Route } from "@/db/types";

export const MIN_SAMPLES = 5;
export const BASELINE_MPS = 25 / 3.6;

type Est = { medianS: number; p20S: number; p80S: number; n: number };
export const asEstimate = ({ medianS, p20S, p80S, n }: Est, level: LegEstimate["level"]): LegEstimate => ({
  medianS,
  p20S,
  p80S,
  n,
  level,
  thin: level === "baseline" || n < MIN_SAMPLES,
});
export const flat = (s: number): LegEstimate => asEstimate({ medianS: s, p20S: s, p80S: s, n: 0 }, "baseline");

/** A learned stat for a service: special services learn on their own legs, regular ones share (serviceId null). */
export function pickStat(
  stats: LegStat[],
  svc: { id: string; kind: string },
  kind: "leg" | "dwell",
  from: string,
  to: string | null,
  hour: number | null,
): LegStat | undefined {
  const scope = svc.kind === "special" ? svc.id : null;
  return stats.find(
    (s) =>
      s.kind === kind &&
      s.fromSpotId === from &&
      s.toSpotId === to &&
      s.serviceId === scope &&
      s.hourBucket === hour &&
      s.n >= (hour === null ? 1 : MIN_SAMPLES),
  );
}

/** The legs of a route with their length and estimate, for `svc` at IST `hour`. */
export function routeLegs(
  stats: LegStat[],
  svc: { id: string; kind: string },
  route: Pick<Route, "spotIds" | "spotPathIdx" | "path" | "typicalLegS">,
  hour: number,
): EtaLeg[] {
  const ids = route.spotIds;
  const pIdx = route.spotPathIdx;
  const learned = (s: LegStat | undefined, level: LegEstimate["level"]) => s && asEstimate(s, level);
  const legs: EtaLeg[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const from = ids[i] as string;
    const to = ids[i + 1] as string;
    const lengthM = pIdx.length === ids.length ? pathLengthM(route.path.slice(pIdx[i], (pIdx[i + 1] ?? 0) + 1)) : 0;
    const typical = route.typicalLegS[i];
    const estimate =
      learned(pickStat(stats, svc, "leg", from, to, hour), "leg_hour") ??
      learned(pickStat(stats, svc, "leg", from, to, null), "leg_day") ??
      (typical ? asEstimate({ medianS: typical, p20S: typical, p80S: typical, n: MIN_SAMPLES }, "leg_day") : null) ??
      flat(Math.round(lengthM / BASELINE_MPS));
    legs.push({ fromSpotId: from, toSpotId: to, lengthM, estimate });
  }
  return legs;
}

/** The leg times a prediction paces itself with (seconds; null = none): the same medians the ETA uses. */
export const predictLegS = (legs: EtaLeg[]): (number | null)[] => legs.map((l) => l.estimate.medianS || null);
