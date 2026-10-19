import type { AnswerLine, PublicSpot, ScheduleRow } from "@eci-shuttle/shared";
import { line } from "@tests/factories/bot-attendee";
import { describe, expect, it } from "vitest";
import { allUnseen, departedSince, type ShuttleNow, storyKey, storyText } from "./update-text";

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

/** The voice varies per minute from a small pool: match any phrasing, pin the facts. */
const WAITING = (at: string) => new RegExp(`🚐 <b>The shuttle (is waiting at|is parked at|is hanging out at) ${at}`);
const HERE = (at: string) =>
  new RegExp(`🚐 <b>The shuttle (is at ${at} now|is right here at ${at}|is at ${at}, right where you are)\\.</b>`);
const MOVING = (to: string) =>
  new RegExp(`🚐 <b>The shuttle (is on its way to|is rolling towards|is heading to) ${to}</b>`);
const MOVE_PROMISE =
  /(I'll message you as soon as it starts moving|I'll ping you the moment it starts moving|The second it rolls, you'll hear from me)\./;
const ROAD_PROMISE =
  /(I'll message you as soon as it's on the road again|You'll hear from me the moment it's rolling again)\./;
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
    expect(text).toMatch(WAITING("Circle\\.</b>"));
    expect(text).toContain("\nAs per the schedule it leaves at <b>13:45</b>, landing in Riva around <b>13:53</b>.\n");
    expect(text).toMatch(MOVE_PROMISE);
    expect(text?.split("\n")).toHaveLength(3);
  });

  it("a stop subscriber at that stop hears it's there now", () => {
    const spots = [spot(RIVA, "Riva", [live(0, { phaseText: "here now" })], RIVA_TIMES)];
    const text = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: RIVA, since: NOW - min(5) })],
      spots,
      focusSpotId: RIVA,
      now: NOW - min(2),
    });
    expect(text).toMatch(HERE("Riva"));
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
    expect(text).toContain("It should be off any minute now.");
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
    expect(text).toMatch(WAITING("Circle</b> for passengers\\."));
    expect(text).toContain("\nOnce it leaves, Riva is about 8 min away.\n");
    expect(text).toMatch(MOVE_PROMISE);
  });

  it("varies its phrasing from minute to minute, but says the same thing for the same minute", () => {
    const spots = [spot(RIVA, "Riva", [live(14)], [], 23), spot(CIRCLE, "Circle", [live(0)], [], 23)];
    const say = (now: number) =>
      storyText({
        shuttles: [shuttle({ kind: "waiting", spotId: CIRCLE, since: NOW - min(9) })],
        spots,
        focusSpotId: null,
        now,
      });
    const leads = new Set([0, 1, 2, 3, 4, 5].map((k) => (say(NOW + min(k)) as string).split("\n")[0]));
    expect(leads.size).toBeGreaterThan(1);
    expect(say(NOW)).toBe(say(NOW));
    expect(say(NOW)).toBe(say(NOW + 10_000));
    for (const t of [NOW, NOW + min(1), NOW + min(2)]) {
      const text = say(t) as string;
      expect(text).toMatch(WAITING("Circle</b> for passengers\\."));
      expect(text).not.toMatch(/late|behind|delay/i);
    }
  });
});

describe("storyText: the calm rhythm (promise false)", () => {
  it("makes no 'as soon as it moves' promise while waiting or on a break", () => {
    const spots = [spot(RIVA, "Riva", [live(0)], RIVA_TIMES), spot(CIRCLE, "Circle", [off], CIRCLE_TIMES)];
    const waiting = storyText({
      shuttles: [shuttle({ kind: "waiting", spotId: RIVA, since: NOW - min(2) })],
      spots,
      focusSpotId: null,
      now: NOW,
      promise: false,
    }) as string;
    expect(waiting).toMatch(WAITING("Riva"));
    expect(waiting).not.toMatch(MOVE_PROMISE);
    const brk = storyText({
      shuttles: [shuttle({ kind: "break", until: null, since: NOW - min(3) })],
      spots,
      focusSpotId: null,
      now: NOW,
      promise: false,
    }) as string;
    expect(brk).toContain("break");
    expect(brk).not.toMatch(ROAD_PROMISE);
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
    expect(text).toMatch(MOVING("Riva"));
    expect(text).toMatch(/Riva<\/b> and should be there in about <b>4 min<\/b> \(around 13:24\)\.$/);
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
    expect(text).toMatch(MOVING("Riva"));
    expect(text).toMatch(/and should be there in about <b>4–11 min<\/b>\.$/);
  });

  it("off its usual route: says so gently, with the timetable as a hint", () => {
    const spots = [spot(RIVA, "Riva", [live(9, { phaseText: "off the usual route" })], RIVA_TIMES)];
    const text = storyText({ shuttles: [shuttle({ kind: "off_route" })], spots, focusSpotId: null, now: NOW + 1 });
    expect(text).toBe(
      "🚐 The shuttle is taking the scenic route right now. 🌴\n" +
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
    expect(text).toMatch(MOVING("Riva"));
    expect(text).toContain("Riva</b> and should be there in about <b>4 min</b>");
    expect(text).toContain("\nThen Circle in about <b>20 min</b>.");
  });

  it("stopped on the road: says so, with the estimate", () => {
    const spots = [spot(RIVA, "Riva", [live(6, { phaseText: "stopped on the way" })])];
    const text = storyText({
      shuttles: [shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW - min(5), stopped: true })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toMatch(
      /^🚐 <b>The shuttle has paused on the way to Riva<\/b> (\(traffic or a quick stop\)|\(Goa traffic, most likely 🐄\))\.\n/,
    );
    expect(text).toContain("\nOnce it's moving again, it's about <b>6 min</b> away.");
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
      shuttles: [shuttle({ kind: "break", until: at("12:00"), since: at("11:10") })],
      spots,
      focusSpotId: null,
      now: at("11:20"),
    });
    expect(text).toContain(
      "☕ <b>The shuttle is on a short chai break</b> and should be back around 12:00.\n" +
        "As per the schedule, the next one leaves Riva at <b>12:00</b> and Circle at <b>12:25</b>.\n",
    );
    expect(text).toMatch(ROAD_PROMISE);
  });

  it("an open-ended break on a loop: no time promised, how often it usually runs", () => {
    const spots = [spot(RIVA, "Riva", [off], [], 23)];
    const text = storyText({
      shuttles: [shuttle({ kind: "break", until: null, since: NOW - min(3) })],
      spots,
      focusSpotId: null,
      now: NOW,
    });
    expect(text).toContain(
      "☕ <b>The shuttle is on a short chai break.</b>\nWhen it's running it comes about every 23 min.\n",
    );
    expect(text).toMatch(ROAD_PROMISE);
  });

  it("nothing running at the subscriber's stops → null (the job stays quiet)", () => {
    const done = line({ serviceId: SVC, kind: "none", minutes: null, phaseText: "no more shuttles today" });
    const first = line({ serviceId: SVC, kind: "timetable", minutes: null, phaseText: "first shuttle today" });
    expect(
      storyText({
        shuttles: [shuttle({ kind: "no_signal", last: null })],
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

describe("storyText: when we can't see the shuttle", () => {
  const T = at("13:18");
  const leftRiva = { at: at("13:10"), atSpotId: null, fromSpotId: RIVA, toSpotId: CIRCLE };
  const spots = () => [spot(RIVA, "Riva", [off], [], 38), spot(CIRCLE, "Circle", [off], [], 38)];
  const HELP =
    "If you need to get going: try the ride share section of the Telegram group, or ask the volunteers at Riva or Circle reception.";

  it("a short drop (≤ 5 min) keeps what it was doing, and says how old that is", () => {
    const text = storyText({
      shuttles: [
        shuttle({
          kind: "moving",
          toSpotId: CIRCLE,
          fromSpotId: RIVA,
          since: T - min(4),
          stopped: false,
          seenAgoMs: min(3),
        }),
      ],
      spots: [spot(RIVA, "Riva", [live(20)]), spot(CIRCLE, "Circle", [live(4)])],
      focusSpotId: null,
      now: T,
    }) as string;
    expect(text).toMatch(MOVING("Circle"));
    expect(text).toContain("\nLast seen 3 min ago.");
  });

  it("lost: says so once, where it was last seen, and where to turn; no timetable guesses", () => {
    const text = storyText({
      shuttles: [shuttle({ kind: "no_signal", last: leftRiva })],
      spots: spots(),
      focusSpotId: null,
      now: T,
    });
    expect(text).toBe(
      "📡 <b>I've lost sight of the shuttle.</b> I last saw it on its way to Circle at 13:10. " +
        "It's probably still running, but I can't give you times right now.\n" +
        `${HELP}\nI'll tell you as soon as I can see it again.`,
    );
  });

  it("parked: last seen at a stop, it might still be there", () => {
    const last = { at: at("13:05"), atSpotId: RIVA, fromSpotId: null, toSpotId: null };
    const text = storyText({
      shuttles: [shuttle({ kind: "parked", spotId: RIVA, last })],
      spots: spots(),
      focusSpotId: RIVA,
      now: T,
    });
    expect(text).toBe(
      "🚐 <b>I saw the shuttle parked at Riva at 13:05.</b> It might still be there. I'm not sure, but it's worth checking.\n" +
        "If it's gone, the volunteers at Riva reception can help, or try the ride share section of the Telegram group.",
    );
  });

  it("hidden (silent 30 min): left out while another shuttle runs", () => {
    const text = storyText({
      shuttles: [
        shuttle({ kind: "moving", toSpotId: CIRCLE, fromSpotId: RIVA, since: T, stopped: false }),
        shuttle({ kind: "hidden", last: leftRiva }, "Shuttle 2"),
      ],
      spots: [spot(RIVA, "Riva", [live(20)]), spot(CIRCLE, "Circle", [live(4)])],
      focusSpotId: null,
      now: T,
    }) as string;
    expect(text).toMatch(MOVING("Circle"));
    expect(text).not.toContain("Shuttle 2");
    expect(text.split("\n\n")).toHaveLength(1);
  });

  it("every shuttle hidden: no shuttle we can see, the last one seen today, and where to turn", () => {
    const text = storyText({
      shuttles: [shuttle({ kind: "hidden", last: leftRiva }), shuttle({ kind: "hidden", last: null }, "Shuttle 2")],
      spots: spots(),
      focusSpotId: null,
      now: at("16:05"),
    });
    expect(text).toBe(
      "📡 <b>I can't see a shuttle on the road right now.</b> The last one I saw was on its way to Circle at 13:10. " +
        "One may still be running, but I can't tell you when it'll come.\n" +
        `${HELP}\nI'll message you the moment I see a shuttle again.`,
    );
  });

  it("one lost beside one running: a short line for the lost one, no advice (there's a shuttle)", () => {
    const text = storyText({
      shuttles: [
        shuttle({ kind: "moving", toSpotId: CIRCLE, fromSpotId: RIVA, since: T, stopped: false }),
        shuttle({ kind: "no_signal", last: leftRiva }, "Shuttle 2"),
      ],
      spots: [spot(RIVA, "Riva", [live(20)]), spot(CIRCLE, "Circle", [live(4)])],
      focusSpotId: null,
      now: T,
    }) as string;
    expect(text).toContain("📡 I've lost sight of Shuttle 2. I last saw it on its way to Circle at 13:10.");
    expect(text).not.toContain("ride share");
  });
});

describe("storyText: several shuttles", () => {
  it("names each one and escapes the names", () => {
    const spots = [spot(RIVA, "Riva", [live(4)], []), spot(CIRCLE, "Circle", [live(0)], [])];
    const text = storyText({
      shuttles: [
        shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false }),
        shuttle({ kind: "break", until: null, since: NOW }, "Bus <2>"),
      ],
      spots,
      focusSpotId: null,
      now: NOW,
    }) as string;
    expect(text).toMatch(/<b>Shuttle 1 (is on its way to|is rolling towards|is heading to) Riva<\/b>/);
    expect(text).toContain("<b>Bus &lt;2&gt; is on a short chai break.</b>");
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

describe("storyKey: what an update is about, so the job can tell whether anything changed", () => {
  const moving = shuttle({ kind: "moving", toSpotId: RIVA, fromSpotId: CIRCLE, since: NOW, stopped: false });
  const waitingRiva = shuttle({ kind: "waiting", spotId: RIVA, since: NOW });
  const lost = (last = null) => shuttle({ kind: "no_signal", last });

  it("in sight, wherever it is, is one state for an every-stop subscriber; at your own stop is its own", () => {
    expect(storyKey([moving], null)).toBe(storyKey([waitingRiva], null));
    expect(storyKey([waitingRiva], RIVA)).not.toBe(storyKey([moving], RIVA));
    expect(storyKey([waitingRiva], CIRCLE)).toBe(storyKey([moving], CIRCLE));
  });

  it("parked, lost and hidden are one 'out of sight' state: an outage is told once", () => {
    const last = { at: NOW, atSpotId: RIVA, fromSpotId: null, toSpotId: null };
    const k = storyKey([lost()], null);
    expect(storyKey([shuttle({ kind: "parked", spotId: RIVA, last })], null)).toBe(k);
    expect(storyKey([shuttle({ kind: "hidden", last: null })], null)).toBe(k);
    expect(storyKey([moving], null)).not.toBe(k);
  });

  it("a break, and which shuttles are on shift, are changes", () => {
    expect(storyKey([shuttle({ kind: "break", until: null, since: NOW })], null)).not.toBe(storyKey([moving], null));
    expect(storyKey([moving, lost()], null)).not.toBe(storyKey([moving], null));
  });

  it("never contains a colon (it rides in the outbox dedupe key)", () => {
    expect(storyKey([shuttle({ kind: "no_signal", last: null }, "Bus: 1")], null)).not.toContain(":");
  });

  it("allUnseen: nothing in sight", () => {
    expect(allUnseen(storyKey([lost(), shuttle({ kind: "hidden", last: null }, "B")], null))).toBe(true);
    expect(allUnseen(storyKey([lost(), moving], null))).toBe(false);
  });
});
