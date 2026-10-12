import type { ActualDeparture, DepartureMatch, MatchResult, PlannedDeparture } from "../contracts";

/**
 * Match actual departures to planned ones (SPEC §6a). Pure.
 *
 * - Actual departures are processed in time order; each takes the nearest still-unmatched planned departure
 *   within ±toleranceMin (default 25). Ties (equal distance) go to the earlier planned departure.
 * - A planned departure left unmatched is `missed` (actualId null, delayMin null).
 * - delayMin = (actual − planned) / 60000, rounded to 1 decimal; negative = left early.
 * - Inputs need not be sorted. `matches` has one entry per planned, sorted by planned time.
 * - Actual departures that matched nothing are returned in unmatchedActualIds (time order).
 */
export function matchDepartures(
  planned: PlannedDeparture[],
  actual: ActualDeparture[],
  toleranceMin = 25,
): MatchResult {
  // ponytail: O(planned × actual); a day's departures are tens, so fine. Use a sorted two-pointer if it ever isn't.
  const byTime = <T extends { at: number; id: string }>(a: T, b: T) => a.at - b.at || a.id.localeCompare(b.id);
  const plan = [...planned].sort(byTime);
  const tol = toleranceMin * 60_000;
  const taken = new Map<string, ActualDeparture>();
  const unmatchedActualIds: string[] = [];

  for (const a of [...actual].sort(byTime)) {
    let best: PlannedDeparture | undefined;
    for (const p of plan) {
      const d = Math.abs(a.at - p.at);
      // plan is sorted, so strict < keeps the earlier planned on a tie
      if (d <= tol && !taken.has(p.id) && (!best || d < Math.abs(a.at - best.at))) best = p;
    }
    if (best) taken.set(best.id, a);
    else unmatchedActualIds.push(a.id);
  }

  const matches = plan.map((p): DepartureMatch => {
    const a = taken.get(p.id);
    return a
      ? { plannedId: p.id, actualId: a.id, delayMin: Math.round((a.at - p.at) / 6_000) / 10, missed: false }
      : { plannedId: p.id, actualId: null, delayMin: null, missed: true };
  });
  return { matches, unmatchedActualIds };
}
