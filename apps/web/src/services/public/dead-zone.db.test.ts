import { PublicStatus } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { legStats, routes, services, serviceVehicles, spots, vehicleBreaks, vehicleState, vehicles } from "@/db/schema";
import { liveBoard } from "../mcp/changes";
import type { DeadZone } from "../signal/dead-zones";
import { PublicMap, publicPositions } from "./positions";
import { isPredictedLine, NO_SIGNAL_STRETCH, predictedPhase } from "./sight";
import { staffMap } from "./staff-map";
import { CANT_SEE, publicStatus } from "./status";

const zonesNow = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../signal/dead-zones", () => ({ loadDeadZones: vi.fn(async () => zonesNow.list) }));

const db = () => testDb();
const at = (hhmm: string) => new Date(`2026-10-28T${hhmm}:00+05:30`);
const LEG_S = 600;

/** Nanu → Riva → Circle → Namaka → Circle → Riva → Nanu on a north-south line; no signal Circle → Namaka. */
async function world() {
  const w = await makeWorkspace(db());
  const lat = { nanu: 15.6, riva: 15.61, circle: 15.62, namaka: 15.635 };
  const [nanu, riva, circle, namaka] = await db()
    .insert(spots)
    .values(
      Object.entries(lat).map(([k, v]) => ({
        workspaceId: w.id,
        name: k === "namaka" ? "Namaka Cove" : k,
        shortName: k[0]?.toUpperCase() + k.slice(1),
        lat: v,
        lng: 73.7,
      })),
    )
    .returning();
  const order = [nanu, riva, circle, namaka, circle, riva, nanu];
  const [route] = await db()
    .insert(routes)
    .values({
      workspaceId: w.id,
      name: "Nanu ⇄ Namaka",
      spotIds: order.map((s) => (s as { id: string }).id),
      path: order.map((s) => ({ lat: (s as { lat: number }).lat, lng: 73.7 })),
      spotPathIdx: [0, 1, 2, 3, 4, 5, 6],
    })
    .returning();
  const [svc] = await db()
    .insert(services)
    .values({
      workspaceId: w.id,
      name: "Main loop",
      kind: "regular",
      routeId: route.id,
      public: true,
      validFrom: "2026-10-01",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "22:00",
      pattern: { kind: "loop" },
    })
    .returning();
  const ids = order.map((s) => (s as { id: string }).id);
  // metres along the path of Circle and Namaka (first pass)
  const { spotAlongM } = await import("./predict");
  const along = spotAlongM({ spotIds: ids, spotPathIdx: [0, 1, 2, 3, 4, 5, 6], path: route.path }) as number[];
  const zone: DeadZone = {
    routeId: route.id,
    legIndex: 2,
    fromSpotId: circle.id,
    toSpotId: namaka.id,
    startAlongM: null,
    endAlongM: null,
    source: "manual",
    typicalLegS: LEG_S,
  };
  zonesNow.list = [zone];
  return { w, nanu, riva, circle, namaka, route, svc, along };
}

async function shuttle(w: { id: string }, svcId: string, state: Partial<typeof vehicleState.$inferInsert>) {
  const [v] = await db().insert(vehicles).values({ workspaceId: w.id, name: "Van 1", colour: "#286c71" }).returning();
  await db()
    .insert(serviceVehicles)
    .values({ workspaceId: w.id, serviceId: svcId, vehicleId: v.id, startsAt: at("08:00"), endsAt: at("23:00") });
  await db()
    .insert(vehicleState)
    .values({ vehicleId: v.id, workspaceId: w.id, serviceId: svcId, phase: "en_route", ...state });
  return v;
}

const lineAt = async (wsId: string, spotId: string, now: Date) => {
  const s = PublicStatus.parse(await publicStatus(db(), wsId, now));
  return s.spots.find((x) => x.spotId === spotId)?.answers[0];
};

beforeEach(() => {
  zonesNow.list = [];
});

const mapOf = async (wsId: string, now: Date) => PublicMap.parse(await publicPositions(db(), wsId, now));

describe("a shuttle that drives into the no-signal stretch between Circle and Namaka", () => {
  /** last fix 19:00, 100 m after leaving Circle; then nothing */
  async function departed(state: Partial<typeof vehicleState.$inferInsert> = {}) {
    const x = await world();
    const v = await shuttle(x.w, x.svc.id, {
      spotId: x.circle.id,
      nextSpotId: x.namaka.id,
      alongM: (x.along[2] as number) + 100,
      lat: 15.6201,
      lng: 73.7,
      lastPingAt: at("19:00"),
      since: at("18:59"),
      ...state,
    });
    return { ...x, v };
  }

  it("goes live → predicted (estimated place advancing) → 'can't see it' → live again", async () => {
    const { w, namaka, circle, route, v, along } = await departed();
    const legStart = along[2] as number;
    const legEnd = along[3] as number;

    // 19:03: the plain live ladder; no estimate on the map
    expect((await lineAt(w.id, namaka.id, at("19:03")))?.phaseText).toBe("on the way");
    expect((await mapOf(w.id, at("19:03"))).vehicles[0]?.estimate).toBeUndefined();

    // 19:06: predicted, about 3 min from Namaka, approximate, never lateness
    const l6 = await lineAt(w.id, namaka.id, at("19:06"));
    expect(l6).toMatchObject({
      kind: "live",
      phaseText: `on its way to Namaka · ${NO_SIGNAL_STRETCH}`,
      approx: true,
      vehicleName: "Van 1",
      lastSeenS: 360,
    });
    expect(l6?.minutes).toBeGreaterThanOrEqual(2);
    expect(l6?.minutes).toBeLessThanOrEqual(4);
    expect(JSON.stringify(l6)).not.toMatch(/late|behind/i);
    const m6 = await mapOf(w.id, at("19:06"));
    const v6 = m6.vehicles[0];
    expect(v6).toMatchObject({
      id: v.id,
      routeId: route.id,
      phase: "en_route",
      atSpotId: null,
      nextSpotId: namaka.id,
      nextSpotName: "Namaka",
      legIndex: 2,
      estimate: { reason: "no_signal", lastSeenAt: at("19:00").toISOString() },
      lastSeenS: 360,
    });
    expect(v6?.alongM).toBeGreaterThan(legStart + 100);
    expect(v6?.alongM).toBeLessThan(legEnd);
    expect(v6?.lat).toBeGreaterThan(15.6201);
    expect(v6?.headingDeg).toBeCloseTo(0, 0);

    // 19:08: further along, fewer minutes; at 19:12 held short of Namaka and "1 min", never "here now"
    const v8 = (await mapOf(w.id, at("19:08"))).vehicles[0];
    expect(v8?.alongM).toBeGreaterThan(v6?.alongM as number);
    expect(v8?.lat).toBeGreaterThan(v6?.lat as number);
    expect((await lineAt(w.id, namaka.id, at("19:08")))?.minutes).toBeLessThanOrEqual(l6?.minutes as number);
    const v12 = (await mapOf(w.id, at("19:12"))).vehicles[0];
    expect(v12?.alongM).toBeLessThan(legEnd);
    expect(v12?.legFraction).toBeLessThan(1);
    const l12 = await lineAt(w.id, namaka.id, at("19:12"));
    expect(l12?.minutes).toBe(1);
    expect(l12?.kind).toBe("live");

    // the stop it left is behind it: Circle's next arrival is a later pass (chained), still an estimate
    const circleLine = await lineAt(w.id, circle.id, at("19:06"));
    expect(circleLine?.kind).toBe("live");
    expect(circleLine?.approx).toBe(true);
    expect(circleLine?.minutes).toBeGreaterThan(l6?.minutes as number);

    // 19:15: exactly the expiry (1.5 × 10 min) is still predicted; 19:16 → today's ladder
    expect((await lineAt(w.id, namaka.id, at("19:15")))?.phaseText).toContain(NO_SIGNAL_STRETCH);
    expect((await mapOf(w.id, at("19:15"))).vehicles).toHaveLength(1);
    const gone = await lineAt(w.id, namaka.id, at("19:16"));
    expect(gone?.kind).toBe("timetable");
    expect(gone?.phaseText).toMatch(new RegExp(`^${CANT_SEE} · last seen on its way to Namaka at 19:00$`));
    expect((await mapOf(w.id, at("19:16"))).vehicles).toEqual([]);

    // it reappears (a fix at Namaka's end of the leg): live wins at once, no estimate
    await db()
      .update(vehicleState)
      .set({ lastPingAt: at("19:17"), alongM: legEnd - 30, lat: 15.6349, since: at("19:17") })
      .where(eq(vehicleState.vehicleId, v.id));
    const back = await mapOf(w.id, at("19:17"));
    expect(back.vehicles).toHaveLength(1);
    expect(back.vehicles[0]?.estimate).toBeUndefined();
    expect(back.vehicles[0]?.lat).toBe(15.6349);
    const liveLine = await lineAt(w.id, namaka.id, at("19:17"));
    expect(liveLine?.phaseText).not.toContain(NO_SIGNAL_STRETCH);
  });

  it("also works from an 'offline' state, which ingest sets 2 min after the last fix", async () => {
    const { w, namaka } = await departed({ phase: "offline" });
    expect((await lineAt(w.id, namaka.id, at("19:07")))?.phaseText).toContain(NO_SIGNAL_STRETCH);
    expect((await mapOf(w.id, at("19:07"))).vehicles[0]?.estimate?.reason).toBe("no_signal");
  });

  it("without a dead zone nothing changes: lost after 5 min, as before", async () => {
    const { w, namaka } = await departed();
    zonesNow.list = [];
    const l = await lineAt(w.id, namaka.id, at("19:06"));
    expect(l?.kind).toBe("timetable");
    expect(l?.phaseText).toContain(CANT_SEE);
    expect((await mapOf(w.id, at("19:06"))).vehicles).toEqual([]);
  });

  it("a stale zone (not this leg, or the stops changed) predicts nothing", async () => {
    const { w, namaka, riva, circle, route } = await departed();
    zonesNow.list = [
      {
        routeId: route.id,
        legIndex: 1,
        fromSpotId: riva.id,
        toSpotId: circle.id,
        startAlongM: null,
        endAlongM: null,
        source: "detected",
        typicalLegS: LEG_S,
      },
    ];
    expect((await lineAt(w.id, namaka.id, at("19:06")))?.phaseText).toContain(CANT_SEE);
  });

  it("the map keeps the privacy rules: off shift, on a break, retired, another service → not drawn", async () => {
    const { w, v } = await departed();
    // on a driver's break: not a guess we draw
    const [brk] = await db()
      .insert(vehicleBreaks)
      .values({ workspaceId: w.id, vehicleId: v.id, startsAt: at("19:01") })
      .returning();
    expect((await mapOf(w.id, at("19:06"))).vehicles).toEqual([]);
    await db().delete(vehicleBreaks).where(eq(vehicleBreaks.id, brk.id));
    expect((await mapOf(w.id, at("19:06"))).vehicles).toHaveLength(1);
    // off shift
    await db()
      .update(serviceVehicles)
      .set({ endsAt: at("19:02") })
      .where(eq(serviceVehicles.vehicleId, v.id));
    expect((await mapOf(w.id, at("19:06"))).vehicles).toEqual([]);
    await db()
      .update(serviceVehicles)
      .set({ endsAt: at("23:00") })
      .where(eq(serviceVehicles.vehicleId, v.id));
    // retired
    await db().update(vehicles).set({ active: false }).where(eq(vehicles.id, v.id));
    expect((await mapOf(w.id, at("19:06"))).vehicles).toEqual([]);
  });
});

describe("ops views show the same estimate, clearly marked", () => {
  it("staff map: estimated marker at the guessed place (live ones unmarked); live board: estimate beside the last real fix", async () => {
    const { w, namaka, svc, along } = await world();
    const { actor } = await makeAdmin(db(), w.id, "viewer");
    const v = await shuttle(w, svc.id, {
      spotId: (await db().select().from(spots).where(eq(spots.shortName, "Circle")))[0]?.id,
      nextSpotId: namaka.id,
      alongM: (along[2] as number) + 100,
      lat: 15.6201,
      lng: 73.7,
      lastPingAt: at("19:00"),
      since: at("18:59"),
    });
    // 19:03: live: a plain marker, no estimate
    let m = await staffMap(db(), actor, { workspaceId: w.id }, at("19:03"));
    expect(m.markers).toEqual([
      { id: v.id, name: "Van 1", colour: "#286c71", lat: 15.6201, lng: 73.7, problem: false },
    ]);
    expect((await liveBoard(db(), actor, { workspaceId: w.id }, at("19:03")))[0]).not.toHaveProperty("estimate");

    // 19:06: the estimated place, flagged; the board keeps the real last fix in `state`
    m = await staffMap(db(), actor, { workspaceId: w.id }, at("19:06"));
    expect(m.markers).toHaveLength(1);
    expect(m.markers[0]).toMatchObject({ id: v.id, name: "Van 1", estimated: true, problem: false });
    expect(m.markers[0]?.lat).toBeGreaterThan(15.6201);
    const row = (await liveBoard(db(), actor, { workspaceId: w.id }, at("19:06")))[0];
    expect(row?.state?.lat).toBe(15.6201);
    expect(row?.estimate).toMatchObject({
      reason: "no_signal",
      toSpotId: namaka.id,
      lastSeenAt: at("19:00").toISOString(),
      lat: m.markers[0]?.lat,
    });
    expect(row?.estimate?.usuallyArrivesAt).toMatch(/^19:\d\d$/);

    // after the expiry (19:16): no estimate, and the last fix is too old for a pin
    const late = await liveBoard(db(), actor, { workspaceId: w.id }, at("19:16"));
    expect(late[0]).not.toHaveProperty("estimate");
    expect((await staffMap(db(), actor, { workspaceId: w.id }, at("19:16"))).markers).toEqual([]);
  });
});

describe("the way back through the dark leg (Namaka → Circle) and a shared notion of the leg's time", () => {
  it("is estimated on leg 3: the ETA to Circle is the rest of that leg, not the first Riva → Circle leg", async () => {
    const { w, circle, namaka, svc, route, along } = await world();
    zonesNow.list = [
      ...zonesNow.list,
      {
        routeId: route.id,
        legIndex: 3,
        fromSpotId: namaka.id,
        toSpotId: circle.id,
        startAlongM: null,
        endAlongM: null,
        source: "manual",
        typicalLegS: LEG_S,
      } satisfies DeadZone,
    ];
    await shuttle(w, svc.id, {
      spotId: namaka.id,
      nextSpotId: circle.id,
      alongM: (along[3] as number) + 100,
      lat: 15.6349,
      lng: 73.7,
      lastPingAt: at("19:00"),
      since: at("18:59"),
    });
    const l = await lineAt(w.id, circle.id, at("19:06"));
    expect(l?.phaseText).toBe(predictedPhase("Circle"));
    // 6 min on at 1668 m / 600 s = 2.78 m/s: about 570 m (3.4 min) left, not "about 1 min"
    expect(l?.minutes).toBeGreaterThanOrEqual(3);
    expect(l?.minutes).toBeLessThanOrEqual(4);
    const v = (await mapOf(w.id, at("19:06"))).vehicles[0];
    expect(v?.legIndex).toBe(3);
    expect(v?.estimate?.reason).toBe("no_signal");
  });

  it("the ghost van, the ETA and the expiry all use the learned leg time (not a 25 km/h guess)", async () => {
    const { w, namaka, circle, svc, along } = await world();
    zonesNow.list = [{ ...(zonesNow.list[0] as DeadZone), typicalLegS: null }];
    // learned: this leg takes 15 min
    await db().insert(legStats).values({
      workspaceId: w.id,
      kind: "leg",
      fromSpotId: circle.id,
      toSpotId: namaka.id,
      hourBucket: null,
      n: 10,
      medianS: 900,
      p20S: 800,
      p80S: 1000,
      level: "leg_day",
    });
    await shuttle(w, svc.id, {
      spotId: circle.id,
      nextSpotId: namaka.id,
      alongM: (along[2] as number) + 100,
      lat: 15.6201,
      lng: 73.7,
      lastPingAt: at("19:00"),
      since: at("18:59"),
    });
    const legM = (along[3] as number) - (along[2] as number);
    const v6 = (await mapOf(w.id, at("19:06"))).vehicles[0];
    // 6 min at legM / 900 s
    expect(v6?.alongM).toBeCloseTo((along[2] as number) + 100 + 360 * (legM / 900), 0);
    // expiry 1.5 × 15 min = 22.5 min on both the map and the answer
    expect((await lineAt(w.id, namaka.id, at("19:22")))?.phaseText).toBe(predictedPhase("Namaka"));
    expect((await mapOf(w.id, at("19:22"))).vehicles).toHaveLength(1);
    expect((await lineAt(w.id, namaka.id, at("19:23")))?.phaseText).toContain(CANT_SEE);
    expect((await mapOf(w.id, at("19:23"))).vehicles).toEqual([]);
  });

  it("the producer's wording and the matcher that keeps alerts quiet cannot drift apart", async () => {
    const { w, namaka, svc, along, circle } = await world();
    await shuttle(w, svc.id, {
      spotId: circle.id,
      nextSpotId: namaka.id,
      alongM: (along[2] as number) + 100,
      lat: 15.6201,
      lng: 73.7,
      lastPingAt: at("19:00"),
      since: at("18:59"),
    });
    const l = await lineAt(w.id, namaka.id, at("19:06"));
    expect(l && isPredictedLine(l)).toBe(true);
    expect(isPredictedLine({ kind: "live", phaseText: predictedPhase("Anywhere") })).toBe(true);
    expect(isPredictedLine({ kind: "live", phaseText: "on the way" })).toBe(false);
    expect(predictedPhase("X").endsWith(NO_SIGNAL_STRETCH)).toBe(true);
  });
});
