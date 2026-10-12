import type { EpochMs } from "../contracts/common";

/**
 * Average wait for someone who turns up at a random time, from the real headways (SPEC §6a.5): E[H²] / (2·E[H]).
 * Pure. Uneven gaps make it longer than half the mean gap.
 *
 * - headways in seconds (gaps between consecutive actual departures); result in seconds.
 * - Non-positive or non-finite headways are ignored. Empty after filtering → null.
 * - Equal headways H → H / 2.
 */
export function averageWait(headways: number[]): number | null {
  const hs = headways.filter((h) => Number.isFinite(h) && h > 0);
  if (hs.length === 0) return null;
  let sum = 0;
  let sumSq = 0;
  for (const h of hs) {
    sum += h;
    sumSq += h * h;
  }
  return sumSq / (2 * sum); // E[H²]/(2E[H]); the 1/n factors cancel
}

/**
 * Headways in seconds between consecutive departures (epoch ms), sorted first. Pure; does not mutate input.
 * Pass one service window at a time: a gap across windows (overnight, a break) would count as a headway.
 */
export function headwaysFromDepartures(departures: EpochMs[]): number[] {
  const ts = [...departures].sort((a, b) => a - b);
  return ts.slice(1).map((t, i) => (t - ts[i]) / 1000);
}
