import { istToEpoch } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import {
  addDays,
  assignmentRange,
  dayLabel,
  departureLabel,
  describeException,
  describePattern,
  exceptionFormToInput,
  formatRange,
  parseTimes,
  serviceFormToInput,
  weekDays,
  weekStart,
} from "./schedule";

const form = (entries: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};

describe("dates", () => {
  it("adds days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
  });
  it("finds the Monday of the week (Sunday belongs to the week before)", () => {
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // Monday
    expect(weekStart("2026-10-14")).toBe("2026-10-12");
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday
  });
  it("lists 7 days from the start", () => {
    expect(weekDays("2026-10-12")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
  });
  it("labels a day in IST words", () => {
    expect(dayLabel("2026-10-12")).toBe("Mon 12 Oct");
  });
});

describe("describePattern", () => {
  it("says every N min, the times, or loop", () => {
    expect(describePattern({ kind: "every", everyMin: 20 })).toBe("every 20 min");
    expect(describePattern({ kind: "times", times: ["09:00", "12:30"] })).toBe("at 09:00, 12:30");
    expect(describePattern({ kind: "loop" })).toBe("continuous loop");
  });
});

describe("describeException", () => {
  it("reads each kind in plain words", () => {
    expect(describeException({ kind: "cancel_day", departure: null, minutes: null })).toBe("Whole day cancelled");
    expect(describeException({ kind: "cancel_departure", departure: "09:40", minutes: null })).toBe("09:40 cancelled");
    expect(describeException({ kind: "add_departure", departure: "10:15", minutes: null })).toBe("10:15 added");
    expect(describeException({ kind: "shift_minutes", departure: "09:40", minutes: 10 })).toBe("09:40 moved +10 min");
    expect(describeException({ kind: "shift_minutes", departure: "09:40", minutes: -5 })).toBe("09:40 moved -5 min");
  });
});

describe("departureLabel", () => {
  const base = { serviceId: "s", date: "2026-10-12", shiftedMin: 0, added: false };
  it("shows the IST time, with shifts and additions", () => {
    expect(departureLabel({ ...base, at: istToEpoch("2026-10-12", "09:40"), planned: "09:40" })).toBe("09:40");
    expect(departureLabel({ ...base, at: istToEpoch("2026-10-12", "09:50"), planned: "09:40", shiftedMin: 10 })).toBe(
      "09:50 (was 09:40)",
    );
    expect(departureLabel({ ...base, at: istToEpoch("2026-10-12", "10:15"), planned: "10:15", added: true })).toBe(
      "10:15 (added)",
    );
  });
});

describe("parseTimes", () => {
  it("normalises, sorts and dedupes; keeps bad tokens so validation can name them", () => {
    expect(parseTimes("9:40, 07:00 9:40\n12:05")).toEqual(["07:00", "09:40", "12:05"]);
    expect(parseTimes("")).toEqual([]);
    expect(parseTimes("25:00 abc")).toEqual(["25:00", "abc"]);
  });
});

describe("serviceFormToInput", () => {
  it("builds create fields with an every-N pattern", () => {
    const fd = form([
      ["name", " Riva ↔ Circle "],
      ["kind", "regular"],
      ["routeId", "r1"],
      ["public", "on"],
      ["colour", ""],
      ["validFrom", "2026-10-11"],
      ["validTo", "2026-11-01"],
      ["days", "1"],
      ["days", "3"],
      ["startTime", "08:00"],
      ["endTime", "22:00"],
      ["patternKind", "every"],
      ["everyMin", "20"],
      ["times", "ignored"],
    ]);
    expect(serviceFormToInput(fd)).toEqual({
      name: "Riva ↔ Circle",
      kind: "regular",
      routeId: "r1",
      public: true,
      colour: null,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 3],
      startTime: "08:00",
      endTime: "22:00",
      pattern: { kind: "every", everyMin: 20 },
    });
  });
  it("reads explicit times, loop, unchecked public and a colour", () => {
    const base: [string, string][] = [
      ["name", "Party"],
      ["kind", "special"],
      ["routeId", "r1"],
      ["colour", "#ff0000"],
      ["validFrom", "2026-10-17"],
      ["validTo", "2026-10-17"],
      ["days", "6"],
      ["startTime", "22:00"],
      ["endTime", "02:00"],
    ];
    const times = serviceFormToInput(form([...base, ["patternKind", "times"], ["times", "23:00, 22:00"]]));
    expect(times.public).toBe(false);
    expect(times.colour).toBe("#ff0000");
    expect(times.pattern).toEqual({ kind: "times", times: ["22:00", "23:00"] });
    expect(serviceFormToInput(form([...base, ["patternKind", "loop"]])).pattern).toEqual({ kind: "loop" });
  });
});

describe("exceptionFormToInput", () => {
  it("passes departure and minutes only when given", () => {
    expect(
      exceptionFormToInput(
        form([
          ["serviceId", "s1"],
          ["date", "2026-10-12"],
          ["type", "shift_minutes"],
          ["departure", "09:40"],
          ["minutes", "-10"],
          ["note", " road closed "],
        ]),
      ),
    ).toEqual({
      serviceId: "s1",
      date: "2026-10-12",
      type: "shift_minutes",
      departure: "09:40",
      minutes: -10,
      note: "road closed",
    });
    expect(
      exceptionFormToInput(
        form([
          ["serviceId", "s1"],
          ["date", "2026-10-12"],
          ["type", "cancel_day"],
          ["note", ""],
        ]),
      ),
    ).toEqual({ serviceId: "s1", date: "2026-10-12", type: "cancel_day", departure: null, minutes: null, note: null });
  });
});

describe("assignmentRange", () => {
  it("makes IST timestamps for the day", () => {
    expect(assignmentRange("2026-10-12", "08:00", "13:00")).toEqual({
      startsAt: "2026-10-12T08:00:00+05:30",
      endsAt: "2026-10-12T13:00:00+05:30",
    });
  });
  it("rolls the end into the next day when it is not after the start", () => {
    expect(assignmentRange("2026-10-31", "22:00", "02:00")).toEqual({
      startsAt: "2026-10-31T22:00:00+05:30",
      endsAt: "2026-11-01T02:00:00+05:30",
    });
  });
});

describe("formatRange", () => {
  it("shows IST times, naming the end day only when it differs", () => {
    const s = new Date(istToEpoch("2026-10-12", "08:00"));
    expect(formatRange(s, new Date(istToEpoch("2026-10-12", "13:00")))).toBe("Mon 12 Oct, 08:00–13:00");
    expect(formatRange(s, new Date(istToEpoch("2026-10-13", "02:00")))).toBe("Mon 12 Oct, 08:00 – Tue 13 Oct, 02:00");
  });
});
