/**
 * What the shuttle is doing, for the big answer on the page: the same truth-first rules as the bot's updates
 * (services/subscriptions/update-text.ts). A shuttle waiting at the other stop is shown THERE ("at Circle"), with
 * the timetable only as a safe hint (a departure still ahead; past it, "should be off any minute", never a time
 * already gone) or, on a loop, the ride time once it leaves (learned leg times, else 25 km/h) — not a guessed "about 7 min". One heading to the other
 * stop first keeps its time and says so. Everything else keeps the usual answer (null). Never "late". Pure.
 */
import { type AnswerLine, istHHMM, type PublicSpot } from "@eci-shuttle/shared";
import type { PublicMapRoute, PublicVehicle } from "@/services/public/positions";
import { routePath } from "./map/motion";
import type { Mood } from "./whimsy";

export type Story = {
  label: string;
  /** null = keep the usual big value (the minutes) */
  value: string | null;
  context: string;
  mood: Mood | null;
};

const MIN = 60_000;
const STALE_S = 120;
/** a departure due this long before the shuttle got to the stop isn't the one it waits for */
const ARRIVED_EARLY_SLACK_MS = 2 * MIN;
/** ride speed when nothing better is known (public/status BASELINE_MPS) */
const BASELINE_MPS = 25 / 3.6;

const roundMin = (ms: number) => Math.round(ms / MIN) * MIN;

export function pageStory(input: {
  line: AnswerLine;
  spot: PublicSpot;
  spots: PublicSpot[];
  vehicles: PublicVehicle[];
  routes: PublicMapRoute[];
  nowMs: number;
  /** how old the answer is (edge cache, failed polls), added to last seen */
  ageS: number;
}): Story | null {
  const { line, spot, spots, vehicles, routes, nowMs, ageS } = input;
  if (line.kind !== "live" || line.lastSeenS === null || line.lastSeenS + ageS > STALE_S) return null;
  const v = vehicles.find((x) => x.name === line.vehicleName && !x.onBreak);
  if (!v) return null;
  const seenS = line.lastSeenS + ageS;
  const seen = `last seen ${seenS < 60 ? `${seenS}s` : `${Math.round(seenS / 60)} min`} ago`;
  const name = (id: string | null) => (id && spots.find((s) => s.spotId === id)?.shortName) || "the other stop";

  if (v.phase === "en_route" && v.nextSpotId && v.nextSpotId !== spot.spotId)
    return {
      label: "Shuttle will be here in",
      value: null,
      context: `heading to ${name(v.nextSpotId)} first · ${seen}`,
      mood: null,
    };

  if (v.phase !== "at_spot" || !v.atSpotId || v.atSpotId === spot.spotId) return null;
  const there = name(v.atSpotId);
  const rideMs = rideTimeMs(
    routes.find((r) => r.id === v.routeId),
    v.atSpotId,
    spot.spotId,
  );
  const ride = rideMs ? `about ${Math.max(1, Math.round(rideMs / MIN))} min from here once it leaves` : null;
  const route = routes.find((r) => r.id === v.routeId);
  const k = route ? route.spotIds.indexOf(v.atSpotId) : -1;
  const nextIsHere = !!route && k >= 0 && route.spotIds[k + 1] === spot.spotId;
  const mood: Mood = {
    emoji: "🧺",
    text: nextIsHere ? `Loading up at ${there}. Your stop is next.` : `Loading up at ${there}.`,
  };

  const departures = (spots.find((s) => s.spotId === v.atSpotId)?.schedule.rows ?? [])
    .filter((r) => r.serviceId === line.serviceId)
    .map((r) => Date.parse(r.at))
    .sort((a, b) => a - b);
  let plan: string;
  if (departures.length) {
    const since = Date.parse(v.since);
    const due = departures.find((t) => t >= since - ARRIVED_EARLY_SLACK_MS);
    if (due !== undefined && due >= nowMs)
      plan = `As per the schedule it leaves at ${istHHMM(due)}${rideMs ? ` · here around ${istHHMM(roundMin(due + rideMs))}` : ""}`;
    else plan = ["It should be off any minute", ride].filter(Boolean).join(" · ");
  } else plan = ["Waiting for passengers", ride].filter(Boolean).join(" · ");
  return { label: "Shuttle is", value: `at ${there}`, context: `${plan} · ${seen}`, mood };
}

/** Ride time from one stop to the next time the route reaches another, at the baseline speed; null when unknown. */
function rideTimeMs(route: PublicMapRoute | undefined, fromId: string, toId: string): number | null {
  if (!route || route.spotPathIdx.length !== route.spotIds.length) return null;
  const k = route.spotIds.indexOf(fromId);
  const j = k >= 0 ? route.spotIds.indexOf(toId, k + 1) : -1;
  if (k < 0 || j < 0) return null;
  // learned leg times when every leg on the way has one
  const legs = route.legS.slice(k, j);
  if (legs.length === j - k && legs.every((x) => x > 0)) return legs.reduce((t, x) => t + x, 0) * 1000;
  const { cumM } = routePath(route.path);
  const a = cumM[route.spotPathIdx[k] as number];
  const b = cumM[route.spotPathIdx[j] as number];
  if (a === undefined || b === undefined || b <= a) return null;
  return ((b - a) / BASELINE_MPS) * 1000;
}
