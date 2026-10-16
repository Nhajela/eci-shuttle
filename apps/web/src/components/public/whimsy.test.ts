import type { AnswerLine } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import { dayPart, mood, noShuttleMood } from "./whimsy";

const base: AnswerLine = {
  serviceId: "s",
  serviceName: "Riva ⇄ Circle",
  colour: null,
  kind: "timetable",
  minutes: null,
  rangeLo: null,
  rangeHi: null,
  approx: false,
  nextAt: null,
  nextAtLabel: null,
  phaseText: "live tracking off",
  lastSeenS: null,
  vehicleName: null,
  notices: [],
};
const live = (minutes: number, over: Partial<AnswerLine> = {}): AnswerLine => ({
  ...base,
  kind: "live",
  minutes,
  rangeLo: minutes,
  rangeHi: minutes,
  lastSeenS: 10,
  vehicleName: "Shuttle 1",
  phaseText: "on the way",
  ...over,
});

describe("dayPart", () => {
  it("splits the IST day into night / morning / day / evening", () => {
    expect(dayPart(2)).toBe("night");
    expect(dayPart(5)).toBe("morning");
    expect(dayPart(11)).toBe("day");
    expect(dayPart(17)).toBe("evening");
    expect(dayPart(22)).toBe("night");
  });
});

describe("mood: the little line of whimsy next to the answer", () => {
  it("celebrates a shuttle that is here now", () => {
    expect(mood(live(0, { phaseText: "here now" }), 0, 10)).toEqual({ emoji: "🚐", text: "Shuttle's here! Hop on." });
  });

  it("gets excited as it gets close, and says there's no rush when there is time (never 'chai': that reads as a break)", () => {
    expect(mood(live(1), 0, 10).text).toMatch(/almost/i);
    expect(mood(live(4), 0, 10).text).toMatch(/rolling|on its way/i);
    expect(mood(live(12), 0, 10).text).toMatch(/no rush/i);
    expect(mood(live(12), 0, 10).text).not.toMatch(/chai|break/i);
  });

  it("never mentions lateness, however long the wait", () => {
    for (const m of [0, 1, 3, 7, 15, 40]) expect(mood(live(m), 0, 10).text).not.toMatch(/late|delay|behind/i);
  });

  it("treats a stale live line like a timetable line", () => {
    const m = mood(live(2, { lastSeenS: 200, nextAtLabel: "10:20" }), 0, 10);
    expect(m.text).not.toMatch(/almost/i);
    expect(m.text).toMatch(/timetable/i);
  });

  it("says the driver is on a chai break", () => {
    expect(mood({ ...base, phaseText: "on a short break" }, 0, 10).text).toMatch(/break/i);
  });

  it("before the first shuttle it is still waking up; between runs it follows the timetable", () => {
    expect(mood({ ...base, phaseText: "first shuttle today", nextAtLabel: "09:00" }, 0, 7).text).toMatch(
      /waking|first/i,
    );
    expect(mood({ ...base, nextAtLabel: "10:20" }, 0, 10).text).toMatch(/timetable/i);
  });

  it("tucks the shuttle in at night when the day is done, and rests it by day", () => {
    const done: AnswerLine = { ...base, kind: "none", phaseText: "no more shuttles today" };
    expect(mood(done, 0, 23)).toEqual({ emoji: "🌙", text: "The shuttle's tucked in for the night." });
    expect(mood(done, 0, 15).text).toMatch(/done for today/i);
  });
});

describe("noShuttleMood", () => {
  it("is a day off", () => {
    expect(noShuttleMood(12).emoji).toBe("🏖️");
    expect(noShuttleMood(1).emoji).toBe("🌙");
  });
});
