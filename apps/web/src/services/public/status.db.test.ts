import {
  type Departure,
  type EtaInput,
  PublicStatus,
  type ServiceDef,
  type ServiceExceptionDef,
} from "@eci-shuttle/shared";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  departureMatches,
  devices,
  legStats,
  pings,
  routes,
  services,
  serviceVehicles,
  spots,
  vehicleState,
  vehicles,
} from "@/db/schema";
import type { Notice } from "@/db/types";
import { publicStatus, spotAnswer } from "./status";

// Sibling pure functions / services are built in parallel: pin their behaviour here so these tests only
// exercise svc-public (what it feeds them and how it turns their answers into the public status).
const m = vi.hoisted(() => {
  const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    notices: [] as Notice[],
    expand: (s: ServiceDef, ex: ServiceExceptionDef[], date: string): Departure[] => {
      if (date < s.validFrom || date > s.validTo) return [];
      if (ex.some((e) => e.date === date && e.type === "cancel_day")) return [];
      if (s.pattern.kind !== "times") return [];
      return s.pattern.times.map((t) => ({
        serviceId: s.id,
        date,
        at: ist(t < s.startTime ? nextDay(date) : date, t),
        planned: t,
        shiftedMin: 0,
        added: false,
      }));
    },
  };
});
vi.mock("@eci-shuttle/shared", async (orig) => ({
  ...(await orig<typeof import("@eci-shuttle/shared")>()),
  expandServiceDepartures: vi.fn(m.expand),
  etaToSpot: vi.fn(),
  pathLengthM: vi.fn((p: unknown[]) => (p.length - 1) * 3000),
}));
vi.mock("@/services/notices/notices", () => ({ activeNotices: vi.fn(async () => m.notices) }));
const { etaToSpot } = vi.mocked(await import("@eci-shuttle/shared"));

const db = () => testDb();
const at = (hhmm: string, date = "2026-10-12") => new Date(`${date}T${hhmm}:00+05:30`);
const NOW = at("09:30");

async function world(over: { times?: string[]; validTo?: string } = {}) {
  const w = await makeWorkspace(db());
  const [riva, circle, beach] = await db()
    .insert(spots)
    .values([
      { workspaceId: w.id, name: "Riva Resort", shortName: "Riva", lat: 15.6, lng: 73.7 },
      { workspaceId: w.id, name: "The Circle", shortName: "Circle", lat: 15.61, lng: 73.71 },
      { workspaceId: w.id, name: "Beach", shortName: "Beach", lat: 15.62, lng: 73.72 },
    ])
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: w.id,
      name: "Riva ⇄ Circle",
      spotIds: [riva.id, circle.id, riva.id],
      path: [riva, circle, riva].map(({ lat, lng }) => ({ lat, lng })),
      spotPathIdx: [0, 1, 2],
      typicalLegS: [900, 900],
    })
    .returning();
  const [svc] = await db()
    .insert(services)
    .values({
      workspaceId: w.id,
      name: "Riva ⇄ Circle",
      kind: "regular",
      routeId: route.id,
      colour: "#112233",
      validFrom: "2026-10-01",
      validTo: over.validTo ?? "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "09:00",
      endTime: "11:00",
      pattern: { kind: "times", times: over.times ?? ["09:00", "10:00"] },
    })
    .returning();
  return { w, riva, circle, beach, route, svc };
}

async function bus(
  ws: string,
  serviceId: string,
  name: string,
  state: Partial<typeof vehicleState.$inferInsert> & { phase: "at_spot" | "en_route" | "offline" | "off_duty" },
) {
  const [v] = await db().insert(vehicles).values({ workspaceId: ws, name }).returning();
  await db()
    .insert(serviceVehicles)
    .values({ workspaceId: ws, serviceId, vehicleId: v.id, startsAt: at("08:00"), endsAt: at("12:00") });
  await db()
    .insert(vehicleState)
    .values({ vehicleId: v.id, workspaceId: ws, serviceId, lastPingAt: new Date(NOW.getTime() - 30_000), ...state });
  return v;
}

const answerAt = async (ws: string, spotId: string, now = NOW) => {
  const s = PublicStatus.parse(await publicStatus(db(), ws, now));
  return s.spots.find((x) => x.spotId === spotId);
};

beforeEach(() => {
  m.notices = [];
  etaToSpot.mockReset();
});

describe("publicStatus: spots", () => {
  it("lists spots on public services running today, in route order, and validates against the contract", async () => {
    const { w, riva, circle, beach } = await world();
    // a private service and an expired one to the beach must not add the beach
    const beachRoute = (
      await db()
        .insert(routes)
        .values({ workspaceId: w.id, name: "Beach", spotIds: [beach.id, riva.id], typicalLegS: [600] })
        .returning()
    )[0];
    const base = {
      workspaceId: w.id,
      kind: "special" as const,
      routeId: beachRoute.id,
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "09:00",
      endTime: "11:00",
      pattern: { kind: "times" as const, times: ["10:30"] },
    };
    await db()
      .insert(services)
      .values([
        { ...base, name: "Staff", public: false, validFrom: "2026-10-01", validTo: "2026-11-01" },
        { ...base, name: "Old", validFrom: "2026-10-01", validTo: "2026-10-05" },
      ]);
    const s = PublicStatus.parse(await publicStatus(db(), w.id, NOW));
    expect(s.workspace).toEqual({ slug: w.slug, name: w.name, isLive: false });
    expect(s.spots.map((x) => x.shortName)).toEqual(["Riva", "Circle"]);
    expect(s.spots[0].spotId).toBe(riva.id);
    expect(s.spots[1].spotId).toBe(circle.id);
  });

  it("throws NOT_FOUND for an unknown workspace", async () => {
    await expect(publicStatus(db(), "00000000-0000-4000-8000-000000000000", NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("publicStatus: timetable answers", () => {
  it("with no live vehicle, gives the next departure from that spot and says tracking is off", async () => {
    const { w, riva, circle, svc } = await world();
    const r = (await answerAt(w.id, riva.id))?.answers;
    expect(r).toEqual([
      expect.objectContaining({
        serviceId: svc.id,
        serviceName: "Riva ⇄ Circle",
        colour: "#112233",
        kind: "timetable",
        minutes: null,
        nextAt: at("10:00").toISOString(),
        nextAtLabel: "10:00",
        phaseText: "live tracking off",
        lastSeenS: null,
        vehicleName: null,
      }),
    ]);
    // Circle departures = Riva + 15 min leg + 3 min baseline dwell at Circle
    expect((await answerAt(w.id, circle.id))?.answers[0].nextAtLabel).toBe("10:18");
  });

  it("uses the learned typical time for that slot when there are enough past departures", async () => {
    const { w, riva, svc } = await world();
    await db()
      .insert(departureMatches)
      .values(
        ["2026-10-09", "2026-10-10", "2026-10-11"].map((date, i) => ({
          workspaceId: w.id,
          serviceId: svc.id,
          spotId: riva.id,
          date,
          plannedAt: at("10:00", date),
          actualAt: at("10:04", date),
          delayMin: [3, 4, 6][i],
        })),
      );
    const a = (await answerAt(w.id, riva.id))?.answers[0];
    expect(a).toMatchObject({ kind: "timetable", nextAtLabel: "10:04", phaseText: "live tracking off" });
    // the 10:00 that typically leaves 10:04 is still the next one at 10:02, not skipped for a later run
    expect((await answerAt(w.id, riva.id, at("10:02")))?.answers[0]).toMatchObject({ nextAtLabel: "10:04" });
  });

  it("before the first departure says so; after the last it says no more shuttles today", async () => {
    const { w, riva } = await world();
    expect((await answerAt(w.id, riva.id, at("07:00")))?.answers[0]).toMatchObject({
      kind: "timetable",
      nextAtLabel: "09:00",
      phaseText: "first shuttle today",
    });
    expect((await answerAt(w.id, riva.id, at("10:45")))?.answers[0]).toMatchObject({
      kind: "none",
      nextAt: null,
      phaseText: "no more shuttles today",
    });
  });

  it("keeps a cross-midnight service on the toggle after midnight, with its after-midnight departure", async () => {
    const { w, riva, svc } = await world();
    await db()
      .update(services)
      .set({ startTime: "22:00", endTime: "02:00", pattern: { kind: "times", times: ["22:00", "01:00"] } })
      .where(eq(services.id, svc.id));
    const a = (await answerAt(w.id, riva.id, at("00:30", "2026-10-13")))?.answers[0];
    expect(a).toMatchObject({ serviceId: svc.id, kind: "timetable", nextAtLabel: "01:00" });
  });
});

describe("publicStatus: live answers", () => {
  it("a fresh ping gives a live ETA with range, 'about' when thin, last seen and vehicle", async () => {
    const { w, riva, circle, svc } = await world();
    await bus(w.id, svc.id, "Bus 1", {
      phase: "en_route",
      spotId: riva.id,
      nextSpotId: circle.id,
      alongM: 1000,
      since: at("09:20"),
    });
    etaToSpot.mockReturnValue({ seconds: 380, minutes: 6, lo: 5, hi: 9, basis: "estimate", legsChained: 2 });
    const a = (await answerAt(w.id, riva.id))?.answers[0];
    expect(a).toMatchObject({
      kind: "live",
      minutes: 6,
      rangeLo: 5,
      rangeHi: 9,
      approx: true,
      nextAt: null,
      lastSeenS: 30,
      vehicleName: "Bus 1",
      phaseText: "on the way",
    });
    // chained: target Riva is two legs ahead of a bus on leg 0, on a looping route
    const input = etaToSpot.mock.calls[0][0] as EtaInput;
    expect(input).toMatchObject({
      vehicle: { kind: "en_route", legIndex: 0, alongLegM: 1000 },
      targetSpotId: riva.id,
      loop: true,
      now: NOW.getTime(),
    });
    expect(input.legs.map((l) => [l.fromSpotId, l.toSpotId, l.estimate.medianS])).toEqual([
      [riva.id, circle.id, 900],
      [circle.id, riva.id, 900],
    ]);
  });

  it("a ping older than 2 minutes is not live: the timetable answer shows instead", async () => {
    const { w, riva, circle, svc } = await world();
    await bus(w.id, svc.id, "Bus 1", {
      phase: "en_route",
      nextSpotId: circle.id,
      alongM: 100,
      lastPingAt: new Date(NOW.getTime() - 121_000),
    });
    etaToSpot.mockReturnValue({ seconds: 60, minutes: 1, lo: 1, hi: 1, basis: "learned", legsChained: 1 });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({
      kind: "timetable",
      phaseText: "live tracking off",
    });
  });

  it("a vehicle moved to a party run drops out of the regular line's answers for those hours", async () => {
    const { w, riva, route, svc } = await world();
    const [party] = await db()
      .insert(services)
      .values({
        workspaceId: w.id,
        name: "Party",
        kind: "special",
        public: false,
        routeId: route.id,
        validFrom: "2026-10-01",
        validTo: "2026-11-01",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "09:00",
        endTime: "11:00",
        pattern: { kind: "times", times: ["09:15"] },
      })
      .returning();
    const v = await bus(w.id, svc.id, "Bus 1", { phase: "at_spot", spotId: riva.id, serviceId: party.id });
    await db()
      .insert(serviceVehicles)
      .values({ workspaceId: w.id, serviceId: party.id, vehicleId: v.id, startsAt: at("08:00"), endsAt: at("12:00") });
    const answer = (await answerAt(w.id, riva.id))?.answers[0];
    expect(answer?.kind).not.toBe("live");
    expect(answer?.vehicleName ?? null).toBeNull();
  });

  it("picks the soonest vehicle", async () => {
    const { w, riva, circle, svc } = await world();
    await bus(w.id, svc.id, "Far", { phase: "en_route", nextSpotId: circle.id, alongM: 100 });
    await bus(w.id, svc.id, "Near", { phase: "en_route", nextSpotId: riva.id, alongM: 4000 });
    etaToSpot.mockImplementation((i: EtaInput) => {
      const near = i.vehicle.kind === "en_route" && i.vehicle.legIndex === 1;
      return { seconds: 0, minutes: near ? 4 : 30, lo: 3, hi: 35, basis: "learned", legsChained: 1 };
    });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({
      vehicleName: "Near",
      minutes: 4,
      approx: false,
    });
  });

  it("a vehicle at the spot is here now; leaving another spot says so", async () => {
    const { w, riva, svc } = await world();
    await bus(w.id, svc.id, "Bus 1", { phase: "at_spot", spotId: riva.id, since: at("09:28") });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({
      kind: "live",
      minutes: 0,
      phaseText: "here now",
    });

    const x = await world();
    await bus(x.w.id, x.svc.id, "Bus 2", {
      phase: "en_route",
      spotId: x.circle.id,
      nextSpotId: x.riva.id,
      alongM: 3100,
      since: new Date(NOW.getTime() - 20_000),
    });
    etaToSpot.mockReturnValue({ seconds: 840, minutes: 14, lo: 12, hi: 17, basis: "learned", legsChained: 1 });
    expect((await answerAt(x.w.id, x.riva.id))?.answers[0]).toMatchObject({
      minutes: 14,
      phaseText: "leaving Circle now",
    });
    expect(etaToSpot.mock.calls.map((c) => c[0].vehicle)).toContainEqual({
      kind: "en_route",
      legIndex: 1,
      alongLegM: 100,
    });
  });

  it("an off-route vehicle stays live without a made-up ETA, unless another vehicle has one", async () => {
    const { w, riva, circle, svc } = await world();
    await bus(w.id, svc.id, "Lost", { phase: "en_route", nextSpotId: circle.id, alongM: 100, offRoute: true });
    etaToSpot.mockReturnValue({ seconds: 300, minutes: 5, lo: 4, hi: 6, basis: "learned", legsChained: 1 });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({
      kind: "live",
      minutes: null,
      rangeLo: null,
      phaseText: "off the usual route",
      vehicleName: "Lost",
    });
    await bus(w.id, svc.id, "Fine", { phase: "en_route", nextSpotId: circle.id, alongM: 200 });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({ vehicleName: "Fine", minutes: 5 });
  });

  it("a vehicle that has not moved for 2 minutes is 'stopped on the way'", async () => {
    const { w, riva, circle, svc } = await world();
    const v = await bus(w.id, svc.id, "Bus 1", { phase: "en_route", nextSpotId: circle.id, alongM: 500 });
    const [dev] = await db()
      .insert(devices)
      .values({ workspaceId: w.id, label: "p", tokenHash: crypto.randomUUID() })
      .returning();
    await db()
      .insert(pings)
      .values(
        [150, 90, 30].map((ago) => ({
          workspaceId: w.id,
          deviceId: dev.id,
          vehicleId: v.id,
          recordedAt: new Date(NOW.getTime() - ago * 1000),
          lat: 15.605,
          lng: 73.705,
          accuracy: 5,
          speed: 0,
        })),
      );
    etaToSpot.mockReturnValue({ seconds: 1200, minutes: 20, lo: 18, hi: 25, basis: "learned", legsChained: 2 });
    expect((await answerAt(w.id, riva.id))?.answers[0]).toMatchObject({ minutes: 20, phaseText: "stopped on the way" });
  });

  it("after the last planned run, a bus still pinging on a closed route gives no chained ETA or here now", async () => {
    const { w, riva, circle, svc } = await world();
    const late = at("10:30");
    const lastPingAt = new Date(late.getTime() - 30_000);
    await bus(w.id, svc.id, "Bus 1", { phase: "en_route", nextSpotId: circle.id, alongM: 100, lastPingAt });
    await bus(w.id, svc.id, "Bus 2", { phase: "at_spot", spotId: riva.id, since: at("10:20"), lastPingAt });
    etaToSpot.mockReturnValue({ seconds: 1500, minutes: 25, lo: 22, hi: 30, basis: "learned", legsChained: 1 });
    for (const spot of [circle, riva])
      expect((await answerAt(w.id, spot.id, late))?.answers[0]).toMatchObject({
        kind: "none",
        phaseText: "no more shuttles today",
      });
  });

  it("never shows lateness, even for a shuttle far behind its timetable", async () => {
    const { w, circle, svc } = await world({ times: ["09:00", "10:00", "10:30"] });
    await bus(w.id, svc.id, "Bus 1", {
      phase: "en_route",
      nextSpotId: circle.id,
      alongM: 100,
      lastPingAt: at("09:54"),
    });
    etaToSpot.mockReturnValue({ seconds: 2400, minutes: 40, lo: 35, hi: 45, basis: "learned", legsChained: 2 });
    const s = await publicStatus(db(), w.id, at("09:55"));
    const a = s.spots[0].answers[0];
    expect(a).toMatchObject({ kind: "live", minutes: 40, nextAt: null, nextAtLabel: null });
    expect(JSON.stringify(s)).not.toMatch(/late|behind|delay|on time|expected|planned/i);
  });
});

describe("publicStatus: notices and schedule", () => {
  it("places active notices: everywhere on top, spot on the spot, service on its lines, schedule above the list", async () => {
    const { w, riva, svc } = await world();
    const n = (id: string, placements: Notice["placements"], extra: Partial<Notice> = {}) =>
      ({
        id,
        workspaceId: w.id,
        text: id,
        severity: "info",
        pinned: false,
        sort: 0,
        startsAt: at("08:00"),
        endsAt: null,
        placements,
        ...extra,
      }) as Notice;
    const uuid = (k: number) => `00000000-0000-4000-8000-00000000000${k}`;
    m.notices = [
      n(uuid(1), ["everywhere"], { pinned: true, endsAt: at("12:00") }),
      n(uuid(2), [`spot:${riva.id}`], { severity: "urgent" }),
      n(uuid(3), [`service:${svc.id}`, "schedule"]),
      n(uuid(4), ["admin"]),
    ];
    const s = PublicStatus.parse(await publicStatus(db(), w.id, NOW));
    expect(s.notices).toEqual([
      { id: uuid(1), text: uuid(1), severity: "info", pinned: true, endsAt: at("12:00").toISOString() },
    ]);
    const [rs, cs] = s.spots;
    expect(rs.notices.map((x) => x.id)).toEqual([uuid(2)]);
    expect(cs.notices).toEqual([]);
    expect(rs.answers[0].notices.map((x) => x.id)).toEqual([uuid(3)]);
    expect(rs.schedule.notices.map((x) => x.id)).toEqual([uuid(3)]);
    expect(JSON.stringify(s)).not.toContain(uuid(4));
  });

  it("lists today's departures from the spot with past dimmed and the next one flagged; loops say about every N min", async () => {
    const { w, riva, route, svc } = await world({ times: ["09:00", "10:00", "10:40"] });
    const [loopSvc] = await db()
      .insert(services)
      .values({
        workspaceId: w.id,
        name: "Loop",
        kind: "regular",
        routeId: route.id,
        validFrom: "2026-10-01",
        validTo: "2026-11-01",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "09:00",
        endTime: "18:00",
        pattern: { kind: "loop" },
      })
      .returning();
    const sch = (await answerAt(w.id, riva.id))?.schedule;
    expect(sch?.rows.map((r) => [r.label, r.past, r.next, r.serviceId])).toEqual([
      ["09:00", true, false, svc.id],
      ["10:00", false, true, svc.id],
      ["10:40", false, false, svc.id],
    ]);
    // cycle = two 15-min legs + 3-min baseline dwell at Circle and at Riva, one vehicle (none assigned → 1)
    expect(sch?.loops).toEqual([{ serviceId: loopSvc.id, serviceName: "Loop", everyMin: 36 }]);
    // and the loop's own answer, with nobody tracking, is a plain timetable line without a time
    const loopLine = (await answerAt(w.id, riva.id))?.answers.find((a) => a.serviceId === loopSvc.id);
    expect(loopLine).toMatchObject({
      kind: "timetable",
      nextAt: null,
      phaseText: "about every 36 min · live tracking off",
    });
  });

  it("the route's planned wait at each stop goes into the loop lap, departure offsets and live ETAs", async () => {
    const { w, riva, circle, route, svc } = await world();
    // 5 min at every stop by default; Circle's learned dwell (enough samples) wins, Riva's thin one doesn't
    await db()
      .update(routes)
      .set({ plannedDwellS: { "*": 300 } })
      .where(eq(routes.id, route.id));
    const dwell = (spotId: string, n: number, medianS: number) => ({
      workspaceId: w.id,
      kind: "dwell" as const,
      fromSpotId: spotId,
      n,
      medianS,
      p20S: medianS,
      p80S: medianS,
      level: "leg_day" as const,
    });
    await db()
      .insert(legStats)
      .values([dwell(riva.id, 2, 30), dwell(circle.id, 8, 120)]);
    const [loopSvc] = await db()
      .insert(services)
      .values({
        workspaceId: w.id,
        name: "Loop",
        kind: "regular",
        routeId: route.id,
        colour: "#112233",
        validFrom: "2026-10-01",
        validTo: "2026-11-01",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTime: "09:00",
        endTime: "18:00",
        pattern: { kind: "loop" },
      })
      .returning();
    // lap = two 15-min legs + learned 2 min at Circle + planned 5 min at Riva
    expect((await answerAt(w.id, riva.id))?.schedule.loops).toEqual([
      { serviceId: loopSvc.id, serviceName: "Loop", everyMin: 37 },
    ]);
    // Circle departures = Riva + 15 min leg + learned 2 min at Circle
    expect((await answerAt(w.id, circle.id))?.answers[0].nextAtLabel).toBe("10:17");

    await bus(w.id, svc.id, "Bus 1", { phase: "en_route", spotId: riva.id, nextSpotId: circle.id, alongM: 1000 });
    etaToSpot.mockReturnValue({ seconds: 380, minutes: 6, lo: 5, hi: 9, basis: "estimate", legsChained: 2 });
    await answerAt(w.id, riva.id);
    const input = etaToSpot.mock.calls[0][0] as EtaInput;
    expect(input.dwells[riva.id]?.medianS).toBe(300);
    expect(input.dwells[circle.id]?.medianS).toBe(120);
  });
});

describe("spotAnswer", () => {
  it("returns the same lines as the page for one spot, and [] for a spot without service", async () => {
    const { w, riva, beach } = await world();
    const page = (await answerAt(w.id, riva.id))?.answers;
    expect(await spotAnswer(db(), w.id, riva.id, NOW)).toEqual(page);
    expect(await spotAnswer(db(), w.id, beach.id, NOW)).toEqual([]);
  });
});
