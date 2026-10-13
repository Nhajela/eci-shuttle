/** svc-subscriptions: pure parts of `/need` (no database), so they are unit-tested on their own. */
import { type AnswerLine, istHHMM, type Phase, type PublicSpot, type PublicStatus } from "@eci-shuttle/shared";
import type { Person } from "@/db/types";
import { escapeHtml as esc } from "@/lib/telegram/html";

/** A shuttle is out on this line (live, on a break, between departures), not before or after hours. */
export const running = (l: AnswerLine) =>
  l.kind === "live" || (l.kind === "timetable" && l.phaseText !== "first shuttle today");

/** at most this many names in the ops alert, then "+N more" */
export const ALERT_MAX_NAMES = 5;

/** "Asha (@asha)", "Asha", "@asha" or "Someone". */
export function requesterName(p: Pick<Person, "firstName" | "lastName" | "username">): string {
  const name = p.firstName ?? p.lastName ?? null;
  if (name && p.username) return `${name} (@${p.username})`;
  return name ?? (p.username ? `@${p.username}` : "Someone");
}

/**
 * The stops a shuttle serves right now (a public service is out: live, on a break or between departures), and,
 * when none, the earliest "first shuttle today" start still to come ("12:00"), if any.
 */
export function needSpots(st: PublicStatus): { spots: PublicSpot[]; nextStart: string | null } {
  const now = st.spots.filter((s) => s.answers.some(running));
  if (now.length) return { spots: now, nextStart: null };
  const starts = st.spots
    .flatMap((s) => s.answers)
    .filter((l) => l.kind === "timetable" && l.phaseText === "first shuttle today" && l.nextAt && l.nextAtLabel)
    .sort((a, b) => Date.parse(a.nextAt as string) - Date.parse(b.nextAt as string));
  return { spots: [], nextStart: starts[0]?.nextAtLabel ?? null };
}

/** What to say when no shuttle runs now. */
export const notRunningText = (nextStart: string | null) =>
  `No shuttle is running right now.${nextStart ? ` The next one starts at ${nextStart}.` : ""}`;

/** One active vehicle for the ops alert: its live state with spot names resolved. */
export type AlertVehicle = {
  name: string;
  /** null = never reported */
  phase: Phase | null;
  spotName: string | null;
  nextSpotName: string | null;
  etaS: number | null;
  lastPingAt: Date | null;
  /** undefined = not on a break; null = on a break with no end set */
  breakUntil?: Date | null;
};

/** "at Circle", "on the way to Riva · about 4 min", "offline (last seen 09:51)", "off duty", "+ · on a break …". */
export function vehicleLine(v: AlertVehicle): string {
  let state: string;
  if (v.phase === "at_spot") state = v.spotName ? `at ${v.spotName}` : "at a stop";
  else if (v.phase === "en_route") {
    state = v.nextSpotName ? `on the way to ${v.nextSpotName}` : "on the way";
    if (v.etaS != null) state += ` · about ${Math.max(1, Math.round(v.etaS / 60))} min`;
  } else if (v.phase === "offline") state = v.lastPingAt ? `offline (last seen ${istHHMM(v.lastPingAt)})` : "offline";
  else if (v.phase === "off_duty") state = "off duty";
  else state = "no position yet";
  if (v.breakUntil !== undefined)
    state += v.breakUntil ? ` · on a break till ${istHHMM(v.breakUntil)}` : " · on a break";
  return `${esc(v.name)}: ${esc(state)}`;
}

/**
 * The ops alert when the requests waiting at a stop reach 3, 6, 9 …: the count, up to 5 names with where they go
 * (then "+N more") and since when (IST), then one line per active vehicle. Escaped Telegram HTML.
 */
export function waitingAlertText(input: {
  spotName: string;
  waiting: { name: string; to: string }[];
  since: Date;
  vehicles: AlertVehicle[];
}): string {
  const { spotName, waiting, since, vehicles } = input;
  const shown = waiting.slice(0, ALERT_MAX_NAMES).map((p) => `${esc(p.name)} → ${esc(p.to)}`);
  const more = waiting.length - shown.length;
  return [
    `🙋 <b>${waiting.length} ${waiting.length === 1 ? "person" : "people"} waiting at ${esc(spotName)}</b>`,
    `${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""} · waiting since ${istHHMM(since)}`,
    ...(vehicles.length ? vehicles.map(vehicleLine) : ["No active vehicles."]),
  ].join("\n");
}

export type WaitingPerson = { requestId: string; name: string; toSpotName: string; since: Date };
export type WaitingSpot = { spotId: string; spotName: string; count: number; people: WaitingPerson[] };

/** Rows → per pickup stop, people oldest first; stops by their longest wait. */
export function groupWaiting(
  rows: { requestId: string; spotId: string; spotName: string; name: string; toSpotName: string; since: Date }[],
): WaitingSpot[] {
  const by = new Map<string, WaitingSpot>();
  for (const r of [...rows].sort((a, b) => a.since.getTime() - b.since.getTime())) {
    const g = by.get(r.spotId) ?? { spotId: r.spotId, spotName: r.spotName, count: 0, people: [] };
    g.people.push({ requestId: r.requestId, name: r.name, toSpotName: r.toSpotName, since: r.since });
    g.count++;
    by.set(r.spotId, g);
  }
  return [...by.values()];
}
