import type { LegEstimate } from "../contracts";

/** Reserved key in routes.planned_dwell_s: the route's default wait (seconds) at every stop. */
export const PLANNED_DWELL_DEFAULT = "*";

/** Planned wait (s) at a spot on a route: the spot's own entry, else the route default, else undefined. */
export const plannedDwellS = (plan: Record<string, number>, spotId: string): number | undefined =>
  plan[spotId] ?? plan[PLANNED_DWELL_DEFAULT];

/**
 * The dwell estimate with the route's plan (SPEC §6a): a learned dwell with enough samples (not thin) wins;
 * otherwise the plan, when there is one; otherwise the estimate as is.
 */
export function withPlannedDwell(est: LegEstimate | undefined, plannedS: number | undefined): LegEstimate | undefined {
  if (plannedS == null || (est && !est.thin)) return est;
  return { medianS: plannedS, p20S: plannedS, p80S: plannedS, n: 0, level: "baseline", thin: true };
}
