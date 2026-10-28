/**
 * svc-subscriptions: the words of a 15-min update (pure, no database). Truth first, calm always:
 * - lead with what the shuttle is doing now (waiting at a stop, on its way, paused, on a break), or, when we can't
 *   see it (services/public/sight.ts), what we last saw and where to turn: ride share on the Telegram group or the
 *   volunteers at reception. A shuttle silent for 30 min is left out; with none left, "no shuttle on the road";
 * - the timetable is only a hint, and only where it can't mislead: a departure still ahead for a shuttle waiting
 *   at that stop, or the next ones after a break / while we can't see it. Never a planned time for a moving
 *   shuttle (one off its schedule would make people miss it), never a time already gone, never "late";
 * - "I'll message you as soon as it starts moving" is kept by runUpdates (departedSince); the 30-min rhythm
 *   doesn't make it (`promise: false`).
 * The voice is warm and a little playful (one emoji up front, a chai break, the scenic route), and the lead
 * sentence is picked from a small pool by the minute of `now` (`pick`), so updates don't read like a machine
 * yet the same minute always gives the same words (deterministic, testable). The facts never vary.
 */
import { type AnswerLine, istHHMM, type PublicSpot } from "@eci-shuttle/shared";
import { spotIndexOf } from "@eci-shuttle/shared/geo/legOf";
import { escapeHtml as esc } from "@/lib/telegram/html";
import { renderAnswer } from "../bot/attendee";
import { type LastSeen, lastSeenText } from "../public/sight";
import { running } from "./need-text";

export type ShuttleState =
  /**
   * at a stop, since it got there; nextSpotId = the stop it heads for next, which tells the two visits to a stop apart
   * on a route that passes it twice; seenAgoMs = how old its position is, when over 2 min (a short drop) */
  | { kind: "waiting"; spotId: string; nextSpotId?: string | null; since: number; seenAgoMs?: number }
  /** between stops (fromSpotId = the stop it left, since = when) */
  | { kind: "moving"; toSpotId: string; fromSpotId: string | null; since: number; stopped: boolean; seenAgoMs?: number }
  | { kind: "off_route" }
  /** a driver's break, since it started; until null = open-ended */
  | { kind: "break"; until: number | null; since: number }
  /** last seen inside a stop 5–15 min ago: it might still be there */
  | { kind: "parked"; spotId: string; last: LastSeen }
  /** out of sight for 5–30 min (sight.ts lost) */
  | { kind: "no_signal"; last: LastSeen | null }
  /** silent for more than 30 min: left out of updates until it reports again */
  | { kind: "hidden"; last: LastSeen | null };

export type ShuttleNow = {
  name: string;
  serviceId: string;
  /** the route's spots in order (a loop ends where it starts) */
  routeSpotIds: string[];
  /** typical seconds per leg (routeSpotIds[i] → [i+1]); 0 = unknown */
  legS: number[];
  state: ShuttleState;
};

const MIN = 60_000;
/** a departure that was due this long before the shuttle got to the stop isn't the one it waits for */
const ARRIVED_EARLY_SLACK_MS = 2 * MIN;
/** a range this wide (minutes) is shown as "4–11 min" rather than one number */
const WIDE_RANGE_MIN = 5;

const roundMin = (ms: number) => Math.round(ms / MIN) * MIN;
const minutesText = (n: number) => `${n} min`;

/** One of `pool`, by the minute of `now` plus `salt` (the shuttle's index): stable within a minute, varied over the day. */
const pick = <T>(pool: readonly T[], now: number, salt = 0): T =>
  pool[(Math.floor(now / MIN) + salt) % pool.length] as T;

const WAITING_VERB = ["is waiting at", "is parked at", "is hanging out at"] as const;
const HERE_LEAD = (who: string, at: string) =>
  [`${who} is at ${at} now.`, `${who} is right here at ${at}.`, `${who} is at ${at}, right where you are.`] as const;
const MOVING_VERB = ["is on its way to", "is rolling towards", "is heading to"] as const;
const PAUSED_WHY = ["(traffic or a quick stop)", "(Goa traffic, most likely 🐄)"] as const;
const MOVE_PROMISE = [
  "I'll message you as soon as it starts moving.",
  "I'll ping you the moment it starts moving.",
  "The second it rolls, you'll hear from me.",
] as const;
const ROAD_PROMISE = [
  "I'll message you as soon as it's on the road again.",
  "You'll hear from me the moment it's rolling again.",
] as const;
const RIDE_SHARE = "the ride share section of the Telegram group";
/** "Riva or Circle", "Riva, Circle or Nanu" */
const either = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "the");
const helpLine = (spots: PublicSpot[]) =>
  `If you need to get going: try ${RIDE_SHARE}, or ask the volunteers at ${esc(either([...new Set(spots.map((s) => s.shortName))]))} reception.`;
const newest = (xs: (LastSeen | null)[]) => xs.filter((x): x is LastSeen => !!x).sort((a, b) => b.at - a.at)[0] ?? null;
const unseen = (s: ShuttleNow) => s.state.kind === "no_signal" || s.state.kind === "hidden";

/** A shuttle left a stop after `t` (the update promised "as soon as it starts moving"). */
export function departedSince(shuttles: ShuttleNow[], t: number): boolean {
  return shuttles.some((s) => s.state.kind === "moving" && s.state.fromSpotId !== null && s.state.since > t);
}

/**
 * The update for a subscriber to `focusSpotId` (null = every stop): one short paragraph per shuttle on a service
 * serving those stops. null when no shuttle runs at those stops now (before / after hours): the job stays quiet.
 */
export function storyText(input: {
  shuttles: ShuttleNow[];
  spots: PublicSpot[];
  focusSpotId: string | null;
  now: number;
  /** promise a message as soon as the shuttle moves (the 15-min rhythm keeps it; 30 min doesn't). Default true */
  promise?: boolean;
}): string | null {
  const { spots, focusSpotId, now } = input;
  const focus = focusSpotId ? spots.filter((s) => s.spotId === focusSpotId) : spots;
  if (!focus.some((s) => s.answers.some(running))) return null;
  const served = new Set(focus.flatMap((s) => s.answers.filter(running).map((l) => l.serviceId)));
  const shuttles = input.shuttles.filter((s) => served.has(s.serviceId));
  const name = (id: string) => spots.find((x) => x.spotId === id)?.shortName ?? "a stop";
  const seenText = (last: LastSeen | null) => (last ? lastSeenText(last, name, now) : null);

  // nobody we can describe: the stop answers when someone is live
  if (!shuttles.length && focus.some((s) => s.answers.some((l) => l.kind === "live")))
    return focus
      .filter((s) => s.answers.some(running))
      .map((s) => renderAnswer(s.name, s.answers.filter(running)))
      .join("\n\n");

  const shown = shuttles.filter((s) => s.state.kind !== "hidden");
  if (shown.every(unseen)) {
    const lost = shown.length > 0;
    const where = seenText(newest((lost ? shown : shuttles).map((s) => ("last" in s.state ? s.state.last : null))));
    const who = shown.length === 1 && shuttles.length > 1 ? esc((shown[0] as ShuttleNow).name) : "the shuttle";
    return lost
      ? lines(
          `📡 <b>I've lost sight of ${who}.</b>${where ? ` I last saw it ${esc(where)}.` : ""} ` +
            "It's probably still running, but I can't give you times right now.",
          helpLine(spots),
          "I'll tell you as soon as I can see it again.",
        )
      : lines(
          `📡 <b>I can't see a shuttle on the road right now.</b>${where ? ` The last one I saw was ${esc(where)}.` : ""} ` +
            "One may still be running, but I can't tell you when it'll come.",
          helpLine(spots),
          "I'll message you the moment I see a shuttle again.",
        );
  }

  const ctx: Ctx = { spots, focus, focusSpotId, now, named: shown.length > 1, promise: input.promise ?? true };
  return shown.map((s, i) => paragraph(ctx, s, i)).join("\n\n");
}

type Ctx = {
  spots: PublicSpot[];
  focus: PublicSpot[];
  focusSpotId: string | null;
  now: number;
  named: boolean;
  promise: boolean;
};

const lines = (...xs: (string | null | false)[]) => xs.filter(Boolean).join("\n");

function paragraph(ctx: Ctx, s: ShuttleNow, salt: number): string {
  const { now } = ctx;
  const who = ctx.named ? esc(s.name) : "The shuttle";
  const say = <T>(pool: readonly T[]) => pick(pool, now, salt);
  const name = (id: string | null) => (id && ctx.spots.find((x) => x.spotId === id)?.shortName) || "the next stop";
  const lineFor = (spotId: string): AnswerLine | undefined =>
    ctx.spots
      .find((x) => x.spotId === spotId)
      ?.answers.find((l) => l.kind === "live" && l.serviceId === s.serviceId && l.vehicleName === s.name);
  const st = s.state;
  const ago = (ms: number | undefined) => ms !== undefined && `Last seen ${Math.max(1, Math.round(ms / MIN))} min ago.`;
  const where = (last: LastSeen | null) => last && lastSeenText(last, (id) => name(id), now);

  switch (st.kind) {
    case "waiting": {
      const at = esc(name(st.spotId));
      // a subscriber at that very stop: "is at Riva now"; everyone else: "is waiting at Circle"
      const here = ctx.focusSpotId === st.spotId;
      const head = (tail: string) =>
        here ? `🚐 <b>${say(HERE_LEAD(who, at))}</b>` : `🚐 <b>${who} ${say(WAITING_VERB)} ${at}${tail}`;
      const k = spotIndexOf({ spotIds: s.routeSpotIds }, st.spotId, { nextSpotId: st.nextSpotId ?? undefined });
      const next = k >= 0 ? (s.routeSpotIds[k + 1] ?? null) : null;
      const legMs = k >= 0 ? (s.legS[k] ?? 0) * 1000 : 0;
      const rows = departures(ctx.spots, st.spotId, s.serviceId);
      if (rows.length) {
        // the departure it is waiting for: the first one due once it got here
        const due = rows.find((t) => t >= st.since - ARRIVED_EARLY_SLACK_MS);
        let plan: string | null = null;
        if (due !== undefined && due >= now) {
          const reach =
            next && legMs ? `, landing in ${esc(name(next))} around <b>${istHHMM(roundMin(due + legMs))}</b>` : "";
          plan = `As per the schedule it leaves at <b>${istHHMM(due)}</b>${reach}.`;
        } else if (due !== undefined) plan = "It should be off any minute now.";
        return lines(head(".</b>"), plan, ago(st.seenAgoMs), ctx.promise && say(MOVE_PROMISE));
      }
      // a loop: no promise on when it leaves, only how far the next stop is once it does
      const legMin = Math.round(legMs / MIN);
      return lines(
        head("</b> for passengers."),
        next && legMin ? `Once it leaves, ${esc(name(next))} is about ${minutesText(legMin)} away.` : null,
        ago(st.seenAgoMs),
        ctx.promise && say(MOVE_PROMISE),
      );
    }
    case "moving": {
      const l = lineFor(st.toSpotId);
      const to = esc(name(st.toSpotId));
      if (st.stopped)
        return lines(
          `🚐 <b>${who} has paused on the way to ${to}</b> ${say(PAUSED_WHY)}.`,
          l?.minutes != null ? `Once it's moving again, it's about <b>${minutesText(l.minutes)}</b> away.` : null,
          ago(st.seenAgoMs),
        );
      const eta = l?.minutes != null ? ` and should be there in about ${etaText(l, now)}` : "";
      const focusLine = ctx.focusSpotId && ctx.focusSpotId !== st.toSpotId ? lineFor(ctx.focusSpotId) : undefined;
      return lines(
        `🚐 <b>${who} ${say(MOVING_VERB)} ${to}</b>${eta}.`,
        focusLine?.minutes != null &&
          `Then ${esc(name(ctx.focusSpotId))} in about <b>${minutesText(focusLine.minutes)}</b>.`,
        ago(st.seenAgoMs),
      );
    }
    case "off_route":
      return lines(`🚐 ${who} is taking the scenic route right now. 🌴`, hint(ctx.focus, [s.serviceId], now, "around"));
    case "break": {
      const back = st.until !== null && st.until > now ? st.until : null;
      return lines(
        back
          ? `☕ <b>${who} is on a short chai break</b> and should be back around ${istHHMM(back)}.`
          : `☕ <b>${who} is on a short chai break.</b>`,
        hint(ctx.focus, [s.serviceId], back ?? now, "at", "When it's running it comes"),
        ctx.promise && say(ROAD_PROMISE),
      );
    }
    case "parked": {
      const at = esc(name(st.spotId));
      return lines(
        `🚐 <b>I saw ${ctx.named ? esc(s.name) : "the shuttle"} parked at ${at} at ${istHHMM(st.last.at)}.</b> ` +
          "It might still be there. I'm not sure, but it's worth checking.",
        `If it's gone, the volunteers at ${at} reception can help, or try ${RIDE_SHARE}.`,
      );
    }
    case "no_signal": {
      // another shuttle is in sight (storyText), so no advice here: just what we last saw
      const w = where(st.last);
      return `📡 I've lost sight of ${ctx.named ? esc(s.name) : "the shuttle"}.${w ? ` I last saw it ${esc(w)}.` : ""}`;
    }
    case "hidden":
      return "";
  }
}

/** "about <b>4 min</b> (around 13:24)", or "about <b>4–11 min</b>" when the estimate is wide. */
function etaText(l: AnswerLine, now: number): string {
  const m = l.minutes as number;
  if (l.rangeLo != null && l.rangeHi != null && l.rangeHi - l.rangeLo >= WIDE_RANGE_MIN)
    return `<b>${l.rangeLo}–${l.rangeHi} min</b>`;
  return `<b>${minutesText(m)}</b> (around ${istHHMM(roundMin(now + m * MIN))})`;
}

/** Today's planned departures (epoch ms) of a service from a spot, in order. */
function departures(spots: PublicSpot[], spotId: string, serviceId: string): number[] {
  const s = spots.find((x) => x.spotId === spotId);
  return (s?.schedule.rows ?? [])
    .filter((r) => r.serviceId === serviceId)
    .map((r) => Date.parse(r.at))
    .sort((a, b) => a - b);
}

/**
 * "As per the schedule, the next one leaves Riva at <b>12:00</b> and Circle at <b>12:25</b>." from `after` on,
 * or for a loop "<lead> about every 23 min." null when neither is known.
 */
function hint(
  focus: PublicSpot[],
  serviceIds: string[],
  after: number,
  word: "at" | "around",
  loopLead = "It usually comes",
): string | null {
  const parts: string[] = [];
  for (const s of focus) {
    const next = s.schedule.rows
      .filter((r) => serviceIds.includes(r.serviceId))
      .map((r) => Date.parse(r.at))
      .sort((a, b) => a - b)
      .find((t) => t >= after);
    if (next !== undefined) parts.push(`${esc(s.shortName)} ${word} <b>${istHHMM(next)}</b>`);
  }
  if (parts.length) {
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `As per the schedule, the next one leaves ${list}.`;
  }
  const every = focus.flatMap((s) => s.schedule.loops).find((l) => serviceIds.includes(l.serviceId))?.everyMin;
  return every ? `${loopLead} about every ${every} min.` : null;
}

/** a shuttle's state as far as "did anything change" goes (storyKey) */
const UNSEEN = "unseen";

/**
 * What an update is about, per shuttle on shift: "seen" (waiting or moving anywhere: a departure is its own push),
 * "here" (waiting at the subscriber's own stop), "break", or "unseen" (parked, lost or hidden: one outage is told
 * once). The updates job sends when this changes, plus a check-in when nothing has for a while. No colons: it
 * rides in the outbox dedupe key.
 */
export function storyKey(shuttles: ShuttleNow[], focusSpotId: string | null): string {
  const of = (st: ShuttleState) => {
    switch (st.kind) {
      case "waiting":
        return st.spotId === focusSpotId ? "here" : "seen";
      case "moving":
      case "off_route":
        return "seen";
      case "break":
        return "break";
      default:
        return UNSEEN;
    }
  };
  return shuttles
    .map((s) => `${encodeURIComponent(s.name)}=${of(s.state)}`)
    .sort()
    .join(",");
}

/** Nothing in sight (or no shuttle on shift): after saying so once, check-ins would only repeat it. */
export const allUnseen = (key: string) => key === "" || key.split(",").every((k) => k.endsWith(`=${UNSEEN}`));
