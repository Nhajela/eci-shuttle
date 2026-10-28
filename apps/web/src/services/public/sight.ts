/**
 * svc-public: how well we can see a vehicle right now, from its last position (pure, no database). The ladder:
 * - live: last ping ≤ 5 min old. Its phase stands (a short network drop is not "out of sight"); past 2 min the
 *   answer says how old it is.
 * - parked: last seen inside a stop, 5 to 15 min ago: "it might still be there".
 * - lost: 5 to 30 min out of sight: say so once, with where it was last seen.
 * - hidden: silent for more than 30 min, or never seen: dropped from ETAs and updates until it reports again.
 * - predicted (only when the caller passes a PredictRoute): the exception to lost / hidden. A vehicle whose last
 *   state was en route on a leg known to have no mobile signal (a "dead zone", services/signal/dead-zones.ts) is
 *   silent because of the road, not because something is wrong, so we say where it probably is instead of "can't
 *   see it". See `predictedSight` for the rules.
 * ingest marks a vehicle "offline" 2 min after its last ping and resets `since`; the stop it was at survives in
 * geofence.insideSpotId (arrival in enteredAt) and its leg in spotId / nextSpotId, so the phase is rebuilt.
 */
import { istDate, istHHMM } from "@eci-shuttle/shared";
import type { VehicleState } from "@/db/types";
import type { DeadZone } from "../signal/dead-zones";

const MIN = 60_000;
/** a position this old is plainly live */
export const FRESH_MS = 2 * MIN;
/** up to this, a vehicle without new positions still counts as where it was (a short network drop) */
export const LIVE_MS = 5 * MIN;
/** up to this, a vehicle last seen inside a stop "might still be there" */
export const PARKED_MS = 15 * MIN;
/** past this, a silent vehicle is hidden from attendees until it reports again */
export const HIDDEN_MS = 30 * MIN;

/**
 * A prediction is believed for this many times the leg's travel time (or the time left on it at the last fix, if
 * that is longer) after the last fix; later than that the vehicle is simply lost / hidden again. 1.5 allows for a
 * slow drive through the stretch without keeping a guess on the map forever.
 */
export const PREDICT_EXPIRY_FACTOR = 1.5;
/** …and never longer than this, whatever a mis-learned leg time says */
export const PREDICT_MAX_MS = 60 * MIN;
/** the last fix may be this far before the start of a partial no-signal stretch (the signal goes a little early) */
export const PREDICT_START_SLACK_M = 400;
/** a prediction stops this short of the end of the leg: only a real fix at the stop says "arrived" */
export const PREDICT_ARRIVAL_MARGIN_M = 150;

/**
 * What sight() needs to predict on one route (build it with predict.ts `predictRoute`). Pure data.
 * - spotAlongM[i]: metres along the route path of spotIds[i] (same length as spotIds, non-decreasing);
 * - legS[i]: the learned or baseline travel time of leg i in seconds (null = unknown), the fallback for a zone
 *   without its own `typicalLegS`;
 * - zones: the dead zones of this route (others are ignored).
 */
export type PredictRoute = {
  routeId: string;
  spotIds: string[];
  spotAlongM: number[];
  legS: (number | null)[];
  zones: DeadZone[];
};

/** Where a predicted vehicle probably is. alongM is the estimate; lastAlongM is the real last fix. */
export type PredictedFix = {
  legIndex: number;
  fromSpotId: string;
  toSpotId: string;
  alongM: number;
  lastAlongM: number;
  legStartM: number;
  legEndM: number;
  /** 0..1 along the leg, always < 1 */
  legFraction: number;
  paceMps: number;
  /** travel time of the whole leg, seconds */
  legS: number;
  /** when it usually gets to toSpotId: last fix + the rest of the leg at the pace (may already be in the past) */
  arrivesAtMs: number;
  /** after this the prediction is dropped */
  expiresAtMs: number;
  zone: DeadZone;
};

/**
 * A shuttle in a stretch with no mobile signal that we are estimating (sight.ts "predicted"): its live line ends with
 * this, "on its way to Namaka · no signal on this stretch". Consumers that must not act on a guess (arrival alerts,
 * pickup DMs) recognise the line by it: see isPredictedLine.
 */
export const NO_SIGNAL_STRETCH = "no signal on this stretch";
export const predictedPhase = (toName: string) => `on its way to ${toName} · ${NO_SIGNAL_STRETCH}`;
/** A live line that is an estimate through a no-signal stretch (never "here", never an arrival alert). */
export const isPredictedLine = (l: { kind: string; phaseText: string }) =>
  l.kind === "live" && l.phaseText.endsWith(NO_SIGNAL_STRETCH);
/** Where a vehicle was at its last ping: inside a stop, or between two. */
export type LastSeen = { at: number; atSpotId: string | null; fromSpotId: string | null; toSpotId: string | null };

export type Sight =
  /** state.phase is at_spot or en_route (rebuilt when ingest marked it offline) */
  | { kind: "live"; state: VehicleState; ageMs: number }
  | { kind: "parked"; spotId: string; last: LastSeen }
  | { kind: "lost"; last: LastSeen }
  | { kind: "hidden"; last: LastSeen | null }
  /** state is the en_route state it had, with alongM replaced by the estimate (lat / lng stay the last fix) */
  | { kind: "predicted"; state: VehicleState; last: LastSeen; ageMs: number; estimate: PredictedFix };

export function sight(s: VehicleState | null | undefined, nowMs: number, predict?: PredictRoute): Sight {
  if (!s?.lastPingAt) return { kind: "hidden", last: null };
  const at = s.lastPingAt.getTime();
  const ageMs = Math.max(0, nowMs - at);
  const inside = s.phase === "at_spot" ? s.spotId : (s.geofence?.insideSpotId ?? null);
  const last: LastSeen = inside
    ? { at, atSpotId: inside, fromSpotId: null, toSpotId: null }
    : { at, atSpotId: null, fromSpotId: s.spotId, toSpotId: s.nextSpotId };
  if (ageMs <= LIVE_MS) {
    const state = rebuilt(s, inside);
    if (state) return { kind: "live", state, ageMs };
  } else if (predict && !inside) {
    // live has had its turn (a fresh fix always wins); a guess comes before lost / hidden, not before the truth
    const state = rebuilt(s, inside);
    const estimate = state && predictedFix(state, ageMs, predict);
    if (state && estimate)
      return { kind: "predicted", state: { ...state, alongM: estimate.alongM }, last, ageMs, estimate };
  }
  if (ageMs > HIDDEN_MS) return { kind: "hidden", last };
  if (inside && ageMs <= PARKED_MS) return { kind: "parked", spotId: inside, last };
  return { kind: "lost", last };
}

/**
 * Where a silent vehicle probably is, or null when we have no honest guess. Rules:
 * 1. its last state was en route (a departure is en route too) on leg k, found from the stop it left and the one
 *    it heads to (the along-route position tells apart a pair the route passes twice), and leg k has a dead zone
 *    for this route whose stops still match the route's;
 * 2. the last fix was on the road (not off route) at or just before the start of the no-signal stretch
 *    (PREDICT_START_SLACK_M) or inside it, not past its end;
 * 3. the leg's travel time is known: the zone's typicalLegS, else the leg estimate. pace = leg length / that;
 * 4. alongM = last alongM + silence × pace, held PREDICT_ARRIVAL_MARGIN_M short of the end of the leg and never
 *    behind the last fix. A prediction never says "arrived";
 * 5. believed while the silence is at most PREDICT_EXPIRY_FACTOR × max(leg time, time left at the last fix),
 *    capped by PREDICT_MAX_MS. Past that, null: the caller falls back to lost / hidden.
 */
function predictedFix(s: VehicleState, ageMs: number, p: PredictRoute): PredictedFix | null {
  if (s.phase !== "en_route" || s.offRoute || s.alongM === null || !s.nextSpotId) return null;
  const { spotIds, spotAlongM } = p;
  if (spotAlongM.length !== spotIds.length) return null;
  const along = s.alongM;
  // the leg: spotIds[k] → spotIds[k + 1] with the stops it left and heads to
  const fits = (k: number, withFrom: boolean) =>
    spotIds[k + 1] === s.nextSpotId && (!withFrom || !s.spotId || spotIds[k] === s.spotId);
  const legs = (withFrom: boolean) =>
    spotIds.map((_, k) => k).filter((k) => k < spotIds.length - 1 && fits(k, withFrom));
  const cands = legs(true).length ? legs(true) : legs(false);
  const k =
    cands.find(
      (c) => along >= (spotAlongM[c] as number) - PREDICT_START_SLACK_M && along <= (spotAlongM[c + 1] as number),
    ) ?? cands[0];
  if (k === undefined) return null;
  const legStartM = spotAlongM[k] as number;
  const legEndM = spotAlongM[k + 1] as number;
  const lengthM = legEndM - legStartM;
  if (!(lengthM > 0)) return null;
  const zone = p.zones.find(
    (z) => z.routeId === p.routeId && z.legIndex === k && z.fromSpotId === spotIds[k] && z.toSpotId === spotIds[k + 1],
  );
  if (!zone) return null;
  const zoneStartM = Math.min(legEndM, Math.max(legStartM, zone.startAlongM ?? legStartM));
  const zoneEndM = Math.min(legEndM, Math.max(legStartM, zone.endAlongM ?? legEndM));
  if (!(zoneEndM > zoneStartM)) return null;
  if (along < zoneStartM - PREDICT_START_SLACK_M || along >= zoneEndM) return null;
  const legS = zone.typicalLegS ?? p.legS[k] ?? null;
  if (legS === null || !(legS > 0)) return null;
  const paceMps = lengthM / legS;
  const leftAtFixS = Math.max(0, legEndM - along) / paceMps;
  const expiryMs = Math.min(PREDICT_MAX_MS, Math.max(legS, leftAtFixS) * PREDICT_EXPIRY_FACTOR * 1000);
  if (ageMs > expiryMs) return null;
  const at = (s.lastPingAt as Date).getTime();
  const est = Math.max(along, Math.min(along + (ageMs / 1000) * paceMps, legEndM - PREDICT_ARRIVAL_MARGIN_M));
  return {
    legIndex: k,
    fromSpotId: spotIds[k] as string,
    toSpotId: spotIds[k + 1] as string,
    alongM: est,
    lastAlongM: along,
    legStartM,
    legEndM,
    legFraction: Math.min(1, Math.max(0, (est - legStartM) / lengthM)),
    paceMps,
    legS,
    arrivesAtMs: at + leftAtFixS * 1000,
    expiresAtMs: at + expiryMs,
    zone,
  };
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
