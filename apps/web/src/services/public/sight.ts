/**
 * svc-public: how well we can see a vehicle right now, from its last position (pure, no database). The ladder:
 * - live: last ping ≤ 5 min old. Its phase stands (a short network drop is not "out of sight"); past 2 min the
 *   answer says how old it is.
 * - parked: last seen inside a stop, 5 to 15 min ago: "it might still be there".
 * - lost: 5 to 30 min out of sight: say so once, with where it was last seen.
 * - hidden: silent for more than 30 min, or never seen: dropped from ETAs and updates until it reports again.
 * ingest marks a vehicle "offline" 2 min after its last ping and resets `since`; the stop it was at survives in
 * geofence.insideSpotId (arrival in enteredAt) and its leg in spotId / nextSpotId, so the phase is rebuilt.
 */
import { istDate, istHHMM } from "@eci-shuttle/shared";
import type { VehicleState } from "@/db/types";

const MIN = 60_000;
/** a position this old is plainly live */
export const FRESH_MS = 2 * MIN;
/** up to this, a vehicle without new positions still counts as where it was (a short network drop) */
export const LIVE_MS = 5 * MIN;
/** up to this, a vehicle last seen inside a stop "might still be there" */
export const PARKED_MS = 15 * MIN;
/** past this, a silent vehicle is hidden from attendees until it reports again */
export const HIDDEN_MS = 30 * MIN;

/** Where a vehicle was at its last ping: inside a stop, or between two. */
export type LastSeen = { at: number; atSpotId: string | null; fromSpotId: string | null; toSpotId: string | null };

export type Sight =
  /** state.phase is at_spot or en_route (rebuilt when ingest marked it offline) */
  | { kind: "live"; state: VehicleState; ageMs: number }
  | { kind: "parked"; spotId: string; last: LastSeen }
  | { kind: "lost"; last: LastSeen }
  | { kind: "hidden"; last: LastSeen | null };

export function sight(s: VehicleState | null | undefined, nowMs: number): Sight {
  if (!s?.lastPingAt) return { kind: "hidden", last: null };
  const at = s.lastPingAt.getTime();
  const ageMs = Math.max(0, nowMs - at);
  const inside = s.phase === "at_spot" ? s.spotId : (s.geofence?.insideSpotId ?? null);
  const last: LastSeen = inside
    ? { at, atSpotId: inside, fromSpotId: null, toSpotId: null }
    : { at, atSpotId: null, fromSpotId: s.spotId, toSpotId: s.nextSpotId };
  if (ageMs > HIDDEN_MS) return { kind: "hidden", last };
  if (ageMs <= LIVE_MS) {
    const state = rebuilt(s, inside);
    if (state) return { kind: "live", state, ageMs };
  }
  if (inside && ageMs <= PARKED_MS) return { kind: "parked", spotId: inside, last };
  return { kind: "lost", last };
}

/** The phase it had at its last ping. A rebuilt en_route starts at the epoch, so it never reads as a departure. */
function rebuilt(s: VehicleState, inside: string | null): VehicleState | null {
  if (s.phase === "at_spot" || s.phase === "en_route") return s;
  if (s.phase !== "offline") return null;
  if (inside)
    return {
      ...s,
      phase: "at_spot",
      spotId: inside,
      since: new Date(s.geofence?.enteredAt ?? (s.lastPingAt as Date).getTime()),
    };
  return s.nextSpotId ? { ...s, phase: "en_route", since: new Date(0) } : null;
}

/** "at Riva at 18:58", "on its way to Circle at 18:58", "after leaving Riva at 18:58"; null when not today (IST). */
export function lastSeenText(last: LastSeen, name: (spotId: string) => string, nowMs: number): string | null {
  if (istDate(last.at) !== istDate(nowMs)) return null;
  const t = istHHMM(last.at);
  if (last.atSpotId) return `at ${name(last.atSpotId)} at ${t}`;
  if (last.toSpotId) return `on its way to ${name(last.toSpotId)} at ${t}`;
  if (last.fromSpotId) return `after leaving ${name(last.fromSpotId)} at ${t}`;
  return `at ${t}`;
}
