import { describe, expect, it } from "vitest";
import type { ServiceDef, ServiceExceptionDef } from "../contracts";
import { expandServiceDepartures } from "./departures";

const D = "2026-10-12"; // a Monday
const svc = (over: Partial<ServiceDef> = {}): ServiceDef => ({
  id: "s1",
  kind: "regular",
  routeId: "r1",
  public: true,
  validFrom: "2026-10-11",
  validTo: "2026-11-01",
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: "08:00",
  endTime: "10:00",
  pattern: { kind: "every", everyMin: 20 },
  ...over,
});
const ex = (over: Partial<ServiceExceptionDef>): ServiceExceptionDef => ({
  serviceId: "s1",
  date: D,
  type: "cancel_day",
  departure: null,
  minutes: null,
  ...over,
});
const planned = (s: ServiceDef, e: ServiceExceptionDef[] = [], date = D) =>
  expandServiceDepartures(s, e, date).map((d) => d.planned);
/** epoch ms of an IST wall-clock time */
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

describe("expandServiceDepartures", () => {
  it("every 20 min 08:00–10:00 → 08:00 … 09:40 (end exclusive)", () => {
    const out = expandServiceDepartures(svc(), [], D);
    expect(out.map((d) => d.planned)).toEqual(["08:00", "08:20", "08:40", "09:00", "09:20", "09:40"]);
    expect(out[0]).toEqual({ serviceId: "s1", date: D, at: ist(D, "08:00"), planned: "08:00", shiftedMin: 0, added: false });
  });

  it("explicit times are sorted and kept only inside the window", () => {
    const s = svc({ pattern: { kind: "times", times: ["09:30", "07:59", "08:00", "10:00", "10:01", "08:45"] } });
    expect(planned(s)).toEqual(["08:00", "08:45", "09:30", "10:00"]);
  });

  it("loop pattern → no departures", () => {
    expect(planned(svc({ pattern: { kind: "loop" } }))).toEqual([]);
  });

  it("date before validFrom / after validTo → []", () => {
    expect(planned(svc(), [], "2026-10-10")).toEqual([]);
    expect(planned(svc(), [], "2026-11-02")).toEqual([]);
  });

  it("validFrom and validTo are inclusive", () => {
    expect(planned(svc(), [], "2026-10-11")).toHaveLength(6);
    expect(planned(svc(), [], "2026-11-01")).toHaveLength(6);
  });

  it("weekday not in daysOfWeek → [] (IST weekday, 1 = Monday)", () => {
    const s = svc({ daysOfWeek: [1] });
    expect(planned(s, [], "2026-10-12")).toHaveLength(6); // Monday
    expect(planned(s, [], "2026-10-13")).toEqual([]); // Tuesday
    expect(planned(svc({ daysOfWeek: [7] }), [], "2026-10-18")).toHaveLength(6); // Sunday
  });

  it("cancel_day → []", () => {
    expect(planned(svc(), [ex({ type: "cancel_day" })])).toEqual([]);
  });

  it("cancel_departure removes only that time", () => {
    expect(planned(svc(), [ex({ type: "cancel_departure", departure: "08:40" })])).toEqual([
      "08:00",
      "08:20",
      "09:00",
      "09:20",
      "09:40",
    ]);
  });

  it("shift_minutes +10 moves 09:40 to 09:50 with planned 09:40, shiftedMin 10", () => {
    const out = expandServiceDepartures(svc(), [ex({ type: "shift_minutes", departure: "09:40", minutes: 10 })], D);
    expect(out.at(-1)).toMatchObject({ planned: "09:40", shiftedMin: 10, at: ist(D, "09:50"), added: false });
  });

  it("negative shift moves earlier", () => {
    const out = expandServiceDepartures(svc(), [ex({ type: "shift_minutes", departure: "08:20", minutes: -25 })], D);
    expect(out[0]).toMatchObject({ planned: "08:20", shiftedMin: -25, at: ist(D, "07:55") });
    expect(out.map((d) => d.at)).toEqual([...out.map((d) => d.at)].sort((a, b) => a - b));
  });

  it("add_departure adds an extra one, even outside the window, flagged added", () => {
    const out = expandServiceDepartures(
      svc(),
      [ex({ type: "add_departure", departure: "12:15" }), ex({ type: "add_departure", departure: "08:50" })],
      D,
    );
    expect(out.map((d) => d.planned)).toEqual(["08:00", "08:20", "08:40", "08:50", "09:00", "09:20", "09:40", "12:15"]);
    expect(out[3]).toEqual({ serviceId: "s1", date: D, at: ist(D, "08:50"), planned: "08:50", shiftedMin: 0, added: true });
  });

  it("exception for another service or another date is ignored", () => {
    expect(planned(svc(), [ex({ serviceId: "s2" }), ex({ date: "2026-10-13" })])).toHaveLength(6);
  });

  it("exception naming a time that is not planned is ignored", () => {
    expect(
      planned(svc(), [
        ex({ type: "cancel_departure", departure: "08:10" }),
        ex({ type: "shift_minutes", departure: "08:10", minutes: 5 }),
      ]),
    ).toHaveLength(6);
  });

  it("cross-midnight 22:00–02:00 every 60 → 22,23,00,01; after-midnight ones on date+1, service day = date", () => {
    const out = expandServiceDepartures(
      svc({ startTime: "22:00", endTime: "02:00", pattern: { kind: "every", everyMin: 60 } }),
      [],
      D,
    );
    expect(out.map((d) => d.planned)).toEqual(["22:00", "23:00", "00:00", "01:00"]);
    expect(out.map((d) => d.date)).toEqual([D, D, D, D]);
    expect(out[3]?.at).toBe(ist("2026-10-13", "01:00"));
  });

  it("cross-midnight explicit times and added after-midnight departures land on date+1", () => {
    const s = svc({ startTime: "22:00", endTime: "02:00", pattern: { kind: "times", times: ["00:30", "22:15", "03:00"] } });
    const out = expandServiceDepartures(s, [ex({ type: "add_departure", departure: "01:45" })], D);
    expect(out.map((d) => d.planned)).toEqual(["22:15", "00:30", "01:45"]);
    expect(out[1]?.at).toBe(ist("2026-10-13", "00:30"));
    expect(out[2]?.at).toBe(ist("2026-10-13", "01:45"));
  });

  it("`at` is IST: 08:00 IST on 2026-10-12 == 2026-10-12T02:30:00Z", () => {
    expect(expandServiceDepartures(svc(), [], D)[0]?.at).toBe(Date.parse("2026-10-12T02:30:00Z"));
  });
});
