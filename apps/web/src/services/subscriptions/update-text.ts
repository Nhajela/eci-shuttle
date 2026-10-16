/**
 * svc-subscriptions: the words of a 15-min update (pure, no database). Truth first, calm always:
 * - lead with what the shuttle is doing now (waiting at a stop, on its way, paused, on a break, or out of sight);
 * - the timetable is only a hint, and only where it can't mislead: a departure still ahead for a shuttle waiting
 *   at that stop, or the next ones after a break / while we can't see it. Never a planned time for a moving
 *   shuttle (one off its schedule would make people miss it), never a time already gone, never "late";
 * - "I'll message you as soon as it starts moving" is kept by runUpdates (departedSince).
 */
import { type AnswerLine, istHHMM, type PublicSpot } from "@eci-shuttle/shared";
import { escapeHtml as esc } from "@/lib/telegram/html";
import { renderAnswer } from "../bot/attendee";
import { running } from "./need-text";

export type ShuttleState =
  /** at a stop, since it got there */
  | { kind: "waiting"; spotId: string; since: number }
  /** between stops (fromSpotId = the stop it left, since = when) */
  | { kind: "moving"; toSpotId: string; fromSpotId: string | null; since: number; stopped: boolean }
  | { kind: "off_route" }
  /** a driver's break; until null = open-ended */
  | { kind: "break"; until: number | null }
  /** no fresh position */
  | { kind: "no_signal" };

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

  if (!shuttles.length) {
    // nobody we can describe: the stop answers when someone is live, else what the timetable says
    if (focus.some((s) => s.answers.some((l) => l.kind === "live")))
      return focus
        .filter((s) => s.answers.some(running))
        .map((s) => renderAnswer(s.name, s.answers.filter(running)))
        .join("\n\n");
    return lines("📡 I can't see where the shuttle is right now.", timetableHint([...served], now, "around"));
  }

  const ctx: Ctx = { spots, focus, focusSpotId, now, named: shuttles.length > 1, promise: input.promise ?? true };
  return shuttles.map((s) => paragraph(ctx, s)).join("\n\n");

  function timetableHint(serviceIds: string[], after: number, word: "at" | "around"): string | null {
    return hint(focus, serviceIds, after, word);
  }
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

function paragraph(ctx: Ctx, s: ShuttleNow): string {
  const { now } = ctx;
  const who = ctx.named ? esc(s.name) : "The shuttle";
  const name = (id: string | null) => (id && ctx.spots.find((x) => x.spotId === id)?.shortName) || "the next stop";
  const lineFor = (spotId: string): AnswerLine | undefined =>
    ctx.spots
      .find((x) => x.spotId === spotId)
      ?.answers.find((l) => l.kind === "live" && l.serviceId === s.serviceId && l.vehicleName === s.name);
  const st = s.state;

  switch (st.kind) {
    case "waiting": {
      const at = esc(name(st.spotId));
      // a subscriber at that very stop: "is at Riva now"; everyone else: "is waiting at Circle"
      const here = ctx.focusSpotId === st.spotId;
      const head = (tail: string) =>
        here ? `🚐 <b>${who} is at ${at} now.</b>` : `🚐 <b>${who} is waiting at ${at}${tail}`;
      const k = s.routeSpotIds.indexOf(st.spotId);
      const next = k >= 0 ? (s.routeSpotIds[k + 1] ?? null) : null;
      const legMs = k >= 0 ? (s.legS[k] ?? 0) * 1000 : 0;
      const rows = departures(ctx.spots, st.spotId, s.serviceId);
      if (rows.length) {
        // the departure it is waiting for: the first one due once it got here
        const due = rows.find((t) => t >= st.since - ARRIVED_EARLY_SLACK_MS);
        let plan: string | null = null;
        if (due !== undefined && due >= now) {
          const reach =
            next && legMs
              ? `, which gets it to ${esc(name(next))} around <b>${istHHMM(roundMin(due + legMs))}</b>`
              : "";
          plan = `As per the schedule it leaves at <b>${istHHMM(due)}</b>${reach}.`;
        } else if (due !== undefined) plan = "It should leave soon.";
        return lines(head(".</b>"), plan, ctx.promise && "I'll message you as soon as it starts moving.");
      }
      // a loop: no promise on when it leaves, only how far the next stop is once it does
      const legMin = Math.round(legMs / MIN);
      return lines(
        head("</b> for passengers."),
        next && legMin ? `Once it leaves, it's about ${minutesText(legMin)} to ${esc(name(next))}.` : null,
        ctx.promise && "I'll message you as soon as it starts moving.",
      );
    }
    case "moving": {
      const l = lineFor(st.toSpotId);
      const to = esc(name(st.toSpotId));
      if (st.stopped)
        return lines(
          `🚐 <b>${who} has paused on the way to ${to}</b> (traffic or a stop).`,
          l?.minutes != null ? `Once it's moving again, it's about <b>${minutesText(l.minutes)}</b> away.` : null,
        );
      const eta = l?.minutes != null ? ` and should be there in about ${etaText(l, now)}` : "";
      const focusLine = ctx.focusSpotId && ctx.focusSpotId !== st.toSpotId ? lineFor(ctx.focusSpotId) : undefined;
      return lines(
        `🚐 <b>${who} is on its way to ${to}</b>${eta}.`,
        focusLine?.minutes != null &&
          `Then ${esc(name(ctx.focusSpotId))} in about <b>${minutesText(focusLine.minutes)}</b>.`,
      );
    }
    case "off_route":
      return lines(`🚐 ${who} is taking a different road right now.`, hint(ctx.focus, [s.serviceId], now, "around"));
    case "break": {
      const back = st.until !== null && st.until > now ? st.until : null;
      return lines(
        back
          ? `☕ <b>${who} is on a short break</b> and should be back around ${istHHMM(back)}.`
          : `☕ <b>${who} is on a short break.</b>`,
        hint(ctx.focus, [s.serviceId], back ?? now, "at", "When it's running it comes"),
        ctx.promise && "I'll message you as soon as it's on the road again.",
      );
    }
    case "no_signal":
      return lines(
        `📡 I can't see where ${ctx.named ? esc(s.name) : "the shuttle"} is right now.`,
        hint(ctx.focus, [s.serviceId], now, "around"),
      );
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
