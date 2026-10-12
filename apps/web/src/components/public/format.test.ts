import type { AnswerLine } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import { ageSeconds, answerParts, contextText, pickSpot, spotCookieName } from "./format";

const line = (over: Partial<AnswerLine> = {}): AnswerLine => ({
  serviceId: "s1",
  serviceName: "To Circle",
  colour: null,
  kind: "live",
  minutes: 6,
  rangeLo: 5,
  rangeHi: 9,
  approx: false,
  nextAt: null,
  nextAtLabel: null,
  phaseText: "leaving Riva now",
  lastSeenS: 12,
  vehicleName: "Van 1",
  notices: [],
  ...over,
});

describe("answerParts", () => {
  it("live, one service: 'Shuttle will be here in 6 min (5–9)'", () => {
    expect(answerParts(line(), true)).toEqual({ label: "Shuttle will be here in", value: "6 min", range: "5–9" });
  });

  it("live, several services: labelled by service name", () => {
    expect(answerParts(line(), false)).toEqual({ label: "To Circle", value: "6 min", range: "5–9" });
  });

  it("thin data says 'about'", () => {
    expect(answerParts(line({ approx: true }), true).value).toBe("about 6 min");
  });

  it("no range when lo = hi or missing", () => {
    expect(answerParts(line({ rangeLo: 6, rangeHi: 6 }), true).range).toBeNull();
    expect(answerParts(line({ rangeLo: null, rangeHi: null }), true).range).toBeNull();
  });

  it("0 minutes reads as 'here now'", () => {
    expect(answerParts(line({ minutes: 0, rangeLo: 0, rangeHi: 2 }), true)).toEqual({
      label: "Shuttle is",
      value: "here now",
      range: null,
    });
  });

  it("timetable: next scheduled time, never pretends to be live", () => {
    const t = line({ kind: "timetable", minutes: null, rangeLo: null, rangeHi: null, nextAtLabel: "09:40" });
    expect(answerParts(t, true)).toEqual({ label: "Next scheduled", value: "09:40", range: null });
    expect(answerParts(t, false)).toEqual({ label: "To Circle", value: "09:40", range: null });
  });

  it("none: nothing more today", () => {
    const n = line({ kind: "none", minutes: null, rangeLo: null, rangeHi: null, phaseText: "no more shuttles today" });
    expect(answerParts(n, true)).toEqual({ label: "To Circle", value: "No more today", range: null });
  });
});

describe("contextText", () => {
  it("phase plus last seen, aged by how old the answer is", () => {
    expect(contextText(line(), 0)).toBe("leaving Riva now · last seen 12s ago");
    expect(contextText(line(), 50)).toBe("leaving Riva now · last seen 1 min ago");
    expect(contextText(line({ lastSeenS: 200 }), 0)).toBe("leaving Riva now · last seen 3 min ago");
  });

  it("no last seen when not live", () => {
    expect(contextText(line({ kind: "timetable", lastSeenS: null, phaseText: "live tracking off" }), 30)).toBe(
      "live tracking off",
    );
  });

  it("the timetable and none phase lines are passed through", () => {
    expect(contextText(line({ kind: "none", lastSeenS: null, phaseText: "no more shuttles today" }), 0)).toBe(
      "no more shuttles today",
    );
  });
});

describe("never shows lateness", () => {
  it("no rendered text mentions late or behind", () => {
    const lines = [
      line(),
      line({ approx: true }),
      line({ kind: "timetable", nextAtLabel: "22:00", phaseText: "live tracking off", lastSeenS: null }),
      line({ kind: "none", phaseText: "no more shuttles today", lastSeenS: null }),
    ];
    for (const l of lines) {
      const p = answerParts(l, true);
      const text = `${p.label} ${p.value} ${p.range ?? ""} ${contextText(l, 0)}`.toLowerCase();
      expect(text).not.toMatch(/late|behind|delay/);
    }
  });
});

describe("ageSeconds", () => {
  it("seconds since generatedAt, never negative", () => {
    const now = new Date("2026-10-12T10:00:30Z");
    expect(ageSeconds("2026-10-12T10:00:00Z", now)).toBe(30);
    expect(ageSeconds("2026-10-12T10:00:40Z", now)).toBe(0);
  });
});

describe("pickSpot", () => {
  const spots = [{ spotId: "riva" }, { spotId: "circle" }];
  it("the remembered spot when it is still offered", () => {
    expect(pickSpot(spots, "circle")).toBe("circle");
  });
  it("falls back to the first spot", () => {
    expect(pickSpot(spots, "party")).toBe("riva");
    expect(pickSpot(spots, undefined)).toBe("riva");
  });
  it("null when no spots", () => {
    expect(pickSpot([], "riva")).toBeNull();
  });
});

describe("spotCookieName", () => {
  it("one cookie per workspace", () => {
    expect(spotCookieName(null)).toBe("eci_spot");
    expect(spotCookieName("test")).toBe("eci_spot_test");
  });
});
