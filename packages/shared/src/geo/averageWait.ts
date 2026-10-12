import { notImplemented } from "../notImplemented";

/**
 * Average wait for someone who turns up at a random time, from the real headways (SPEC §6a.5): E[H²] / (2·E[H]).
 * Pure. Uneven gaps make it longer than half the mean gap.
 *
 * - headways in seconds (gaps between consecutive actual departures); result in seconds.
 * - Non-positive or non-finite headways are ignored. Empty after filtering → null.
 * - Equal headways H → H / 2.
 */
export function averageWait(headways: number[]): number | null {
  return notImplemented(headways);
}
