import type { ActualDeparture, MatchResult, PlannedDeparture } from "../contracts";
import { notImplemented } from "../notImplemented";

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
  return notImplemented(planned, actual, toleranceMin);
}
