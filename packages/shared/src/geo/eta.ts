import type { EtaInput, EtaResult } from "../contracts";
import { notImplemented } from "../notImplemented";

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
  return notImplemented(input);
}
