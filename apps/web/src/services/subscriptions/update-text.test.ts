import type { AnswerLine, PublicSpot, ScheduleRow } from "@eci-shuttle/shared";
import { line } from "@tests/factories/bot-attendee";
import { describe, expect, it } from "vitest";
import { departedSince, type ShuttleNow, storyText } from "./update-text";

const SVC = "00000000-0000-4000-8000-000000000000";
const RIVA = "11111111-1111-4111-8111-111111111111";
const CIRCLE = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-15T07:50:00Z"); // 13:20 IST
const at = (hhmm: string) => Date.parse(`2026-10-15T${hhmm}:00+05:30`);
const min = (n: number) => n * 60_000;

const row = (hhmm: string): ScheduleRow => ({
  serviceId: SVC,
  serviceName: "Shuttle",
  at: new Date(at(hhmm)).toISOString(),
  label: hhmm,
  past: at(hhmm) < NOW,
  next: false,
});

function spot(id: string, name: string, answers: AnswerLine[], rows: string[] = [], everyMin?: number): PublicSpot {
  return {
    spotId: id,
    name: `${name} long name`,
    shortName: name,
    notices: [],
    answers,
    schedule: {
      notices: [],
      rows: rows.map(row),
      loops: everyMin ? [{ serviceId: SVC, serviceName: "Shuttle", everyMin }] : [],
    },
  };
}

const live = (minutes: number, over: Partial<AnswerLine> = {}) =>
  line({ serviceId: SVC, serviceName: "Shuttle", vehicleName: "Shuttle 1", minutes, ...over });
const off = line({
  serviceId: SVC,
  kind: "timetable",
  minutes: null,
  phaseText: "live tracking off",
  vehicleName: null,
});

const RIVA_TIMES = ["12:40", "13:20", "14:00", "14:40"];
const CIRCLE_TIMES = ["13:05", "13:45", "14:25", "15:05"];

const shuttle = (state: ShuttleNow["state"], name = "Shuttle 1"): ShuttleNow => ({
  name,
  serviceId: SVC,
  routeSpotIds: [RIVA, CIRCLE, RIVA],
  legS: [450, 460],
  state,
});

describe("storyText: a shuttle waiting at a stop", () => {
  it("with a timetable: when it leaves, when it should reach the next stop, and that we'll say when it moves", () => {
    const spots = [
      spot(RIVA, "Riva", [live(30)], RIVA_TIMES),
      spot(CIRCLE, "Circle", [live(0, { phaseText: "here now" })], CIRCLE_TIMES),
    ];
    const text = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: CIRCLE, since: NOW - min(10) })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe(
      "🚐 <b>The shuttle is waiting at Circle.</b>\n" +
        "As per the schedule it leaves at <b>13:45</b>, which gets it to Riva around <b>13:53</b>.\n" +
        "I'll message you as soon as it starts moving.",
    );
  });

  it("a stop subscriber at that stop hears it's there now", () => {
    const spots = [spot(RIVA, "Riva", [live(0, { phaseText: "here now" })], RIVA_TIMES)];
    const text = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: RIVA, since: NOW - min(5) })],
      spots,
      focusSpotId: RIVA,
      now: NOW - min(2),
    });
    expect(text).toContain("<b>The shuttle is at Riva now.</b>");
    expect(text).toContain("As per the schedule it leaves at <b>13:20</b>");
  });

  it("past its departure time it just 'should leave soon': never a time already gone", () => {
    const spots = [spot(CIRCLE, "Circle", [live(0, { phaseText: "here now" })], CIRCLE_TIMES)];
    const text = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: CIRCLE, since: at("13:00") })],
      spots,
      focusSpotId: null,
      now: at("13:50"),
    }) as string;
    expect(text).toContain("It should leave soon.");
    expect(text).not.toContain("13:45");
    expect(text).not.toContain("14:25");
    expect(text).not.toMatch(/late|behind|delay/i);
  });

  it("a loop (no timetable): waiting for passengers, with the next stop's estimate", () => {
    const spots = [spot(RIVA, "Riva", [live(14)], [], 23), spot(CIRCLE, "Circle", [live(0)], [], 23)];
    const text = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: CIRCLE, since: NOW - min(2) })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe(
      "🚐 <b>The shuttle is waiting at Circle</b> for passengers.\n" +
        "Once it leaves, it's about 8 min to Riva.\n" +
        "I'll message you as soon as it starts moving.",
    );
  });
});

describe("storyText: a moving shuttle", () => {
  it("on its way: minutes and clock time; no timetable promise (a shuttle off its schedule would make people miss it)", () => {
    const spots = [spot(RIVA, "Riva", [live(4)], RIVA_TIMES), spot(CIRCLE, "Circle", [live(20)], CIRCLE_TIMES)];
    const text = storyText({
      shuttles: [shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW - min(3), stopped: false })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe(
      "🚐 <b>The shuttle is on its way to Riva</b> and should be there in about <b>4 min</b> (around 13:24).",
    );
    expect(text).not.toContain("14:00");
  });

  it("a wide estimate is shown as a range, calmly", () => {
    const spots = [spot(RIVA, "Riva", [live(6, { rangeLo: 4, rangeHi: 11 })])];
    const text = storyText({
      shuttles: [shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe("🚐 <b>The shuttle is on its way to Riva</b> and should be there in about <b>4–11 min</b>.");
  });

  it("off its usual route: says so gently, with the timetable as a hint", () => {
    const spots = [spot(RIVA, "Riva", [live(9, { phaseText: "off the usual route" })], RIVA_TIMES)];
    const text = storyText({ shuttles: [shuttle({ kind: "off_route" })], spots, focusSpotId: null, now: NOW + 1 });
    expect(text).toBe(
      "🚐 The shuttle is taking a different road right now.\n" +
        "As per the schedule, the next one leaves Riva around <b>14:00</b>.",
    );
  });

  it("a subscriber at the stop after hears their own estimate too", () => {
    const spots = [spot(RIVA, "Riva", [live(4)], RIVA_TIMES), spot(CIRCLE, "Circle", [live(20)], CIRCLE_TIMES)];
    const text = storyText({
      shuttles: [shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false })],
      spots,
      focusSpotId: CIRCLE,
      now: NOW,
    });
    expect(text).toContain("on its way to Riva</b> and should be there in about <b>4 min</b>");
    expect(text).toContain("Then Circle in about <b>20 min</b>.");
  });

  it("stopped on the road: says so, with the estimate", () => {
    const spots = [spot(RIVA, "Riva", [live(6, { phaseText: "stopped on the way" })])];
    const text = storyText({
      shuttles: [shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW - min(5), stopped: true })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe(
      "🚐 <b>The shuttle has paused on the way to Riva</b> (traffic or a stop).\n" +
        "Once it's moving again, it's about <b>6 min</b> away.",
    );
  });
});

describe("storyText: not running now", () => {
  it("on a break: when it's back, and the schedule's next departures after that", () => {
    const spots = [
      spot(
        RIVA,
        "Riva",
        [line({ serviceId: SVC, kind: "timetable", minutes: null, phaseText: "on a short break" })],
        ["10:00", "12:00", "12:40"],
      ),
      spot(CIRCLE, "Circle", [off], ["10:25", "12:25"]),
    ];
    const text = storyText({
      shuttles: [shuttle({ kind: "break", until: at("12:00") })],
      spots,
      focusSpotId: null,
      now: at("11:20"),
    });
    expect(text).toBe(
      "☕ <b>The shuttle is on a short break</b> and should be back around 12:00.\n" +
        "As per the schedule, the next one leaves Riva at <b>12:00</b> and Circle at <b>12:25</b>.\n" +
        "I'll message you as soon as it's on the road again.",
    );
  });

  it("an open-ended break on a loop: no time promised, how often it usually runs", () => {
    const spots = [spot(RIVA, "Riva", [off], [], 23)];
    const text = storyText({
      shuttles: [shuttle({ kind: "break", until: null })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toBe(
      "☕ <b>The shuttle is on a short break.</b>\n" +
        "When it's running it comes about every 23 min.\n" +
        "I'll message you as soon as it's on the road again.",
    );
  });

  it("no signal: says live tracking is off, then the schedule", () => {
    const spots = [spot(RIVA, "Riva", [off], RIVA_TIMES), spot(CIRCLE, "Circle", [off], CIRCLE_TIMES)];
    const text = storyText({ shuttles: [shuttle({ kind: "no_signal" })], spots, focusSpotId: RIVA, now: NOW + 1 });
    expect(text).toBe(
      "📡 I can't see where the shuttle is right now.\n" +
        "As per the schedule, the next one leaves Riva around <b>14:00</b>.",
    );
  });

  it("nothing running at the subscriber's stops → null (the job stays quiet)", () => {
    const done = line({ serviceId: SVC, kind: "none", minutes: null, phaseText: "no more shuttles today" });
    const first = line({ serviceId: SVC, kind: "timetable", minutes: null, phaseText: "first shuttle today" });
    expect(
      storyText({
        shuttles: [shuttle({ kind: "no_signal" })],
        spots: [spot(RIVA, "Riva", [done]), spot(CIRCLE, "Circle", [first])],
        focusSpotId: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("no shuttle known but a live answer: falls back to the stop answers", () => {
    const text = storyText({ shuttles: [], spots: [spot(RIVA, "Riva", [live(6)])], focusSpotId: null, now: NOW });
    expect(text).toBe("<b>Riva long name</b>\nShuttle: here in <b>6 min</b> (5–9) · live");
  });
});

describe("storyText: several shuttles", () => {
  it("names each one and escapes the names", () => {
    const spots = [spot(RIVA, "Riva", [live(4)], []), spot(CIRCLE, "Circle", [live(0)], [])];
    const text = storyText({
      shuttles: [
        shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false }),
        shuttle({ kind: "break", until: null }, "Bus <2>"),
      ],
      spots,
      focusSpotId: null,
      now: NOW,
    }) as string;
    expect(text).toContain("<b>Shuttle 1 is on its way to Riva</b>");
    expect(text).toContain("<b>Bus &lt;2&gt; is on a short break.</b>");
  });
});

describe("departedSince", () => {
  it("true when a shuttle left a stop after the given time", () => {
    const moving = shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false });
    expect(departedSince([moving], NOW - 1)).toBe(true);
    expect(departedSince([moving], NOW)).toBe(false);
    const noFrom = shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: null, since: NOW, stopped: false });
    expect(departedSince([noFrom], NOW - 1)).toBe(false);
    expect(departedSince([shuttle({ kind: "waiting", spotId: RIVA, since: NOW })], NOW - 1)).toBe(false);
  });
});
