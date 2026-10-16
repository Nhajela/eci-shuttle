import type { AnswerLine, PublicSpot, ScheduleRow } from "@eci-shuttle/shared";
import { describe, expect, it } from "vitest";
import type { PublicMapRoute, PublicVehicle } from "@/services/public/positions";
import { pageStory } from "./story";

const SVC = "00000000-0000-4000-8000-000000000000";
const RIVA = "11111111-1111-4111-8111-111111111111";
const CIRCLE = "22222222-2222-4222-8222-222222222222";
const ROUTE = "33333333-3333-4333-8333-333333333333";
const at = (hhmm: string) => Date.parse(`2026-10-16T${hhmm}:00+05:30`);
const NOW = at("13:30");

const row = (hhmm: string): ScheduleRow => ({
  serviceId: SVC,
  serviceName: "Shuttle",
  at: new Date(at(hhmm)).toISOString(),
  label: hhmm,
  past: at(hhmm) < NOW,
  next: false,
});
const spot = (id: string, shortName: string, rows: string[] = []): PublicSpot => ({
  spotId: id,
  name: `${shortName} long`,
  shortName,
  notices: [],
  answers: [],
  schedule: { notices: [], rows: rows.map(row), loops: [] },
});
const live = (over: Partial<AnswerLine> = {}): AnswerLine => ({
  serviceId: SVC,
  serviceName: "Shuttle",
  colour: null,
  kind: "live",
  minutes: 7,
  rangeLo: 6,
  rangeHi: 9,
  approx: true,
  nextAt: null,
  nextAtLabel: null,
  phaseText: "at Circle",
  lastSeenS: 5,
  vehicleName: "Shuttle 1",
  notices: [],
  ...over,
});
// Riva → Circle → Riva, 3 km each way (along a straight north–south line)
const km = 1 / 111.32;
const route: PublicMapRoute = {
  id: ROUTE,
  name: "Loop",
  colour: null,
  spotIds: [RIVA, CIRCLE, RIVA],
  path: [
    { lat: 15.67, lng: 73.71 },
    { lat: 15.67 - 3 * km, lng: 73.71 },
    { lat: 15.67, lng: 73.71 },
  ],
  spotPathIdx: [0, 1, 2],
  lengthM: 6000,
};
const van = (over: Partial<PublicVehicle>): PublicVehicle => ({
  id: "v1",
  name: "Shuttle 1",
  colour: null,
  lat: 15.64,
  lng: 73.71,
  phase: "at_spot",
  onBreak: false,
  routeId: ROUTE,
  atSpotId: CIRCLE,
  nextSpotId: RIVA,
  nextSpotName: "Riva",
  legIndex: null,
  legFraction: null,
  headingDeg: null,
  alongM: 3000,
  since: new Date(at("13:20")).toISOString(),
  lastSeenS: 5,
  ...over,
});

const base = { routes: [route], nowMs: NOW, ageS: 0 };

describe("pageStory: the big answer says what the shuttle is doing, like the bot", () => {
  it("waiting at the other stop on a timetable: 'at Circle', when it leaves, and when it's here", () => {
    const spots = [spot(RIVA, "Riva", ["13:20", "14:00"]), spot(CIRCLE, "Circle", ["13:05", "13:45"])];
    const s = pageStory({ ...base, line: live(), spot: spots[0] as PublicSpot, spots, vehicles: [van({})] });
    expect(s).toMatchObject({ label: "Shuttle is", value: "at Circle" });
    // 3 km at the 25 km/h baseline ≈ 7 min
    expect(s?.context).toBe("As per the schedule it leaves at 13:45 · here around 13:52 · last seen 5s ago");
    expect(s?.mood?.text).toMatch(/Circle/);
    expect(`${s?.value} ${s?.context} ${s?.mood?.text}`).not.toMatch(/late|delay|behind/i);
  });

  it("past its scheduled time it 'should be off any minute', never a time already gone", () => {
    const spots = [spot(RIVA, "Riva", ["13:20", "14:00"]), spot(CIRCLE, "Circle", ["13:05", "13:45", "14:25"])];
    const s = pageStory({
      ...base,
      nowMs: at("13:50"),
      line: live(),
      spot: spots[0] as PublicSpot,
      spots,
      vehicles: [van({ since: new Date(at("13:30")).toISOString() })],
    });
    expect(s?.context).toBe("It should be off any minute · about 7 min from here once it leaves · last seen 5s ago");
    expect(s?.context).not.toMatch(/13:45|14:25/);
  });

  it("a loop (no timetable): waiting for passengers, with the ride time once it leaves", () => {
    const spots = [spot(RIVA, "Riva"), spot(CIRCLE, "Circle")];
    const s = pageStory({ ...base, line: live(), spot: spots[0] as PublicSpot, spots, vehicles: [van({})] });
    expect(s).toMatchObject({ label: "Shuttle is", value: "at Circle" });
    expect(s?.context).toBe("Waiting for passengers · about 7 min from here once it leaves · last seen 5s ago");
  });

  it("heading to the other stop first: keeps the time, says so underneath", () => {
    const spots = [spot(RIVA, "Riva"), spot(CIRCLE, "Circle")];
    const v = van({ phase: "en_route", atSpotId: null, nextSpotId: CIRCLE, nextSpotName: "Circle", alongM: 1000 });
    const s = pageStory({ ...base, line: live({ minutes: 20 }), spot: spots[0] as PublicSpot, spots, vehicles: [v] });
    expect(s).toMatchObject({ value: null, context: "heading to Circle first · last seen 5s ago" });
  });

  it("on its way to you, at your stop, on a break, stale or unknown: the usual answer (null)", () => {
    const spots = [spot(RIVA, "Riva"), spot(CIRCLE, "Circle")];
    const riva = spots[0] as PublicSpot;
    const toYou = van({ phase: "en_route", atSpotId: null, nextSpotId: RIVA });
    expect(pageStory({ ...base, line: live(), spot: riva, spots, vehicles: [toYou] })).toBeNull();
    expect(pageStory({ ...base, line: live(), spot: riva, spots, vehicles: [van({ atSpotId: RIVA })] })).toBeNull();
    expect(pageStory({ ...base, line: live(), spot: riva, spots, vehicles: [van({ onBreak: true })] })).toBeNull();
    expect(pageStory({ ...base, line: live({ lastSeenS: 200 }), spot: riva, spots, vehicles: [van({})] })).toBeNull();
    expect(
      pageStory({ ...base, line: live({ kind: "timetable" }), spot: riva, spots, vehicles: [van({})] }),
    ).toBeNull();
    expect(pageStory({ ...base, line: live(), spot: riva, spots, vehicles: [] })).toBeNull();
  });
});
