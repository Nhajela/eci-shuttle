import { describe, expect, it } from "vitest";
import type { ServiceDef, ServiceExceptionDef, ServiceVehicleDef } from "../contracts";
import { applyDirectives, trackingWindows } from "./windows";

const SVC = "00000000-0000-4000-8000-000000000001";
const SVC2 = "00000000-0000-4000-8000-000000000002";
const VA = "00000000-0000-4000-8000-00000000000a";
const VB = "00000000-0000-4000-8000-00000000000b";

/** epoch ms of an IST wall-clock time */
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

const svc = (o: Partial<ServiceDef> = {}): ServiceDef => ({
  id: SVC,
  kind: "regular",
  routeId: "00000000-0000-4000-8000-0000000000ff",
  public: true,
  validFrom: "2026-10-01",
  validTo: "2026-11-30",
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  startTime: "08:00",
  endTime: "20:00",
  pattern: { kind: "every", everyMin: 30 },
  ...o,
});
const sv = (o: Partial<ServiceVehicleDef> = {}): ServiceVehicleDef => ({
  id: "00000000-0000-4000-8000-0000000000e1",
  serviceId: SVC,
  vehicleId: VA,
  startsAt: ist("2026-10-01", "00:00"),
  endsAt: ist("2026-12-01", "00:00"),
  ...o,
});
const ex = (o: Partial<ServiceExceptionDef>): ServiceExceptionDef => ({
  serviceId: SVC,
  date: "2026-10-12",
  type: "cancel_day",
  departure: null,
  minutes: null,
  ...o,
});
// 2026-10-12 is a Monday (IST)
const DAY_FROM = ist("2026-10-12", "00:00");
const DAY_TO = ist("2026-10-13", "00:00");

describe("trackingWindows", () => {
  it("one service 08:00–20:00, one vehicle assigned all day → 07:45–20:15", () => {
    expect(trackingWindows([sv()], [svc()], [], DAY_FROM, DAY_TO)).toEqual([
      { vehicleId: VA, startsAt: ist("2026-10-12", "07:45"), endsAt: ist("2026-10-12", "20:15"), serviceIds: [SVC] },
    ]);
  });

  it("custom padMin 0 → exact service window", () => {
    const [w] = trackingWindows([sv()], [svc()], [], DAY_FROM, DAY_TO, 0);
    expect([w?.startsAt, w?.endsAt]).toEqual([ist("2026-10-12", "08:00"), ist("2026-10-12", "20:00")]);
  });

  it("assignment shorter than the window clips it (vehicle moved to a party service)", () => {
    const rows = [sv({ endsAt: ist("2026-10-12", "18:00") })];
    const [w] = trackingWindows(rows, [svc()], [], DAY_FROM, DAY_TO);
    expect([w?.startsAt, w?.endsAt]).toEqual([ist("2026-10-12", "07:45"), ist("2026-10-12", "18:00")]);
  });

  it("service with no assigned vehicle → nothing", () => {
    expect(trackingWindows([sv({ serviceId: SVC2 })], [svc()], [], DAY_FROM, DAY_TO)).toEqual([]);
    expect(trackingWindows([], [svc()], [], DAY_FROM, DAY_TO)).toEqual([]);
  });

  it("cancel_day → no window that day", () => {
    expect(trackingWindows([sv()], [svc()], [ex({ type: "cancel_day" })], DAY_FROM, DAY_TO)).toEqual([]);
    // a cancel_day for another service or date changes nothing
    const other = [ex({ serviceId: SVC2 }), ex({ date: "2026-10-13" })];
    expect(trackingWindows([sv()], [svc()], other, DAY_FROM, DAY_TO)).toHaveLength(1);
  });

  it("non-running weekday → no window", () => {
    expect(trackingWindows([sv()], [svc({ daysOfWeek: [6, 7] })], [], DAY_FROM, DAY_TO)).toEqual([]);
    expect(trackingWindows([sv()], [svc({ validTo: "2026-10-11" })], [], DAY_FROM, DAY_TO)).toEqual([]);
  });

  it("cross-midnight 22:00–02:00 → 21:45–02:15 spanning two dates", () => {
    const s = svc({ startTime: "22:00", endTime: "02:00", daysOfWeek: [1] });
    expect(trackingWindows([sv()], [s], [], DAY_FROM, ist("2026-10-14", "00:00"))).toEqual([
      { vehicleId: VA, startsAt: ist("2026-10-12", "21:45"), endsAt: ist("2026-10-13", "02:15"), serviceIds: [SVC] },
    ]);
  });

  it("a service day that started yesterday still contributes after midnight", () => {
    // Monday-only party service; asking from Tuesday 00:00 still sees Monday's tail
    const s = svc({ startTime: "22:00", endTime: "02:00", daysOfWeek: [1] });
    const from = ist("2026-10-13", "00:00");
    expect(trackingWindows([sv()], [s], [], from, ist("2026-10-14", "00:00"))).toEqual([
      { vehicleId: VA, startsAt: from, endsAt: ist("2026-10-13", "02:15"), serviceIds: [SVC] },
    ]);
  });

  it("add_departure outside the window widens that day's window", () => {
    const exs = [ex({ type: "add_departure", departure: "21:00" })];
    const [w] = trackingWindows([sv()], [svc()], exs, DAY_FROM, DAY_TO);
    expect([w?.startsAt, w?.endsAt]).toEqual([ist("2026-10-12", "07:45"), ist("2026-10-12", "21:15")]);
  });

  it("cross-midnight add_departure in the gap (after end, before start) stays on the service date, like departures.ts", () => {
    const s = svc({ startTime: "22:00", endTime: "02:00", daysOfWeek: [1] });
    const exs = [ex({ type: "add_departure", departure: "21:00" })];
    expect(trackingWindows([sv()], [s], exs, DAY_FROM, ist("2026-10-14", "00:00"))).toEqual([
      { vehicleId: VA, startsAt: ist("2026-10-12", "20:45"), endsAt: ist("2026-10-13", "02:15"), serviceIds: [SVC] },
    ]);
  });

  it("shift_minutes of a planned departure past the window widens it; unplanned time is ignored", () => {
    const shifted = [ex({ type: "shift_minutes", departure: "08:00", minutes: -30 })];
    const [w] = trackingWindows([sv()], [svc()], shifted, DAY_FROM, DAY_TO);
    expect(w?.startsAt).toBe(ist("2026-10-12", "07:15"));
    const unplanned = [ex({ type: "shift_minutes", departure: "08:10", minutes: -60 })];
    const [u] = trackingWindows([sv()], [svc()], unplanned, DAY_FROM, DAY_TO);
    expect(u?.startsAt).toBe(ist("2026-10-12", "07:45"));
  });

  it("two services on one vehicle that overlap after padding merge into one window with both serviceIds", () => {
    const party = svc({ id: SVC2, startTime: "20:20", endTime: "23:00" });
    const rows = [sv(), sv({ id: "00000000-0000-4000-8000-0000000000e2", serviceId: SVC2 })];
    expect(trackingWindows(rows, [svc(), party], [], DAY_FROM, DAY_TO)).toEqual([
      {
        vehicleId: VA,
        startsAt: ist("2026-10-12", "07:45"),
        endsAt: ist("2026-10-12", "23:15"),
        serviceIds: [SVC, SVC2],
      },
    ]);
  });

  it("touching windows (end == start) merge", () => {
    const party = svc({ id: SVC2, startTime: "20:30", endTime: "23:00" });
    const rows = [sv(), sv({ id: "00000000-0000-4000-8000-0000000000e2", serviceId: SVC2 })];
    const out = trackingWindows(rows, [svc(), party], [], DAY_FROM, DAY_TO);
    expect(out).toHaveLength(1);
    expect(out[0]?.endsAt).toBe(ist("2026-10-12", "23:15"));
  });

  it("clipped to [from, to)", () => {
    const from = ist("2026-10-12", "10:00");
    const to = ist("2026-10-12", "12:00");
    expect(trackingWindows([sv()], [svc()], [], from, to)).toEqual([
      { vehicleId: VA, startsAt: from, endsAt: to, serviceIds: [SVC] },
    ]);
    expect(trackingWindows([sv()], [svc()], [], ist("2026-10-12", "21:00"), ist("2026-10-12", "22:00"))).toEqual([]);
  });

  it("48h horizon spanning three service days", () => {
    const from = ist("2026-10-12", "12:00");
    const out = trackingWindows([sv()], [svc()], [], from, from + 48 * 3600_000);
    expect(out.map((w) => [w.startsAt, w.endsAt])).toEqual([
      [from, ist("2026-10-12", "20:15")],
      [ist("2026-10-13", "07:45"), ist("2026-10-13", "20:15")],
      [ist("2026-10-14", "07:45"), ist("2026-10-14", "12:00")],
    ]);
  });

  it("sorted by vehicleId then startsAt", () => {
    const rows = [
      sv({ id: "00000000-0000-4000-8000-0000000000e2", vehicleId: VB }),
      sv({ vehicleId: VA, startsAt: ist("2026-10-13", "00:00") }),
    ];
    const out = trackingWindows(rows, [svc()], [], DAY_FROM, ist("2026-10-15", "00:00"));
    expect(out.map((w) => [w.vehicleId, w.startsAt])).toEqual([
      [VA, ist("2026-10-13", "07:45")],
      [VA, ist("2026-10-14", "07:45")],
      [VB, ist("2026-10-12", "07:45")],
      [VB, ist("2026-10-13", "07:45")],
      [VB, ist("2026-10-14", "07:45")],
    ]);
  });
});

describe("applyDirectives", () => {
  const base = trackingWindows([sv()], [svc()], [], DAY_FROM, DAY_TO); // VA 07:45–20:15
  const d = (kind: "active_window" | "silence_until" | "force_active", a: string, b: string, vehicleId = VA) => ({
    vehicleId,
    kind,
    startsAt: ist("2026-10-12", a),
    endsAt: ist("2026-10-12", b),
  });

  it("no directives → unchanged", () => {
    expect(applyDirectives(base, [])).toEqual(base);
  });

  it("silence_until removes the overlap, splitting a window", () => {
    expect(applyDirectives(base, [d("silence_until", "12:00", "13:00")]).map((w) => [w.startsAt, w.endsAt])).toEqual([
      [ist("2026-10-12", "07:45"), ist("2026-10-12", "12:00")],
      [ist("2026-10-12", "13:00"), ist("2026-10-12", "20:15")],
    ]);
  });

  it("force_active adds a window and merges with touching service windows", () => {
    const out = applyDirectives(base, [d("force_active", "20:15", "22:00"), d("active_window", "02:00", "03:00", VB)]);
    expect(out).toEqual([
      { vehicleId: VA, startsAt: ist("2026-10-12", "07:45"), endsAt: ist("2026-10-12", "22:00"), serviceIds: [SVC] },
      { vehicleId: VB, startsAt: ist("2026-10-12", "02:00"), endsAt: ist("2026-10-12", "03:00"), serviceIds: [] },
    ]);
  });

  it("silence beats force_active, and only hits its own vehicle", () => {
    const out = applyDirectives(base, [d("force_active", "21:00", "23:00"), d("silence_until", "06:00", "23:30")]);
    expect(out).toEqual([]);
    expect(applyDirectives(base, [d("silence_until", "06:00", "23:30", VB)])).toEqual(base);
  });
});
