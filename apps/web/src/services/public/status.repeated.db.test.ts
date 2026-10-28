import { PublicStatus } from "@eci-shuttle/shared";
import { attendee } from "@tests/factories/bot-attendee";
import { makePerson } from "@tests/factories/core";
import { makeOutAndBack } from "@tests/factories/repeated-stops";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outbox, vehicleState } from "@/db/schema";
import { runArrivalAlerts, subscribeArrival } from "../subscriptions/subscriptions";
import { publicStatus } from "./status";

const db = () => testDb();
const NOW = new Date("2026-10-13T09:30:00+05:30");
type World = Awaited<ReturnType<typeof makeOutAndBack>>;
type State = Partial<typeof vehicleState.$inferInsert> & { phase: "at_spot" | "en_route" };

/** The out-and-back loop with its van in the state ingest writes, last heard 20 s ago. */
async function withVan(stateOf: (w: World) => State, pattern?: "times") {
  const w = await makeOutAndBack(db(), { pattern });
  await db()
    .insert(vehicleState)
    .values({
      vehicleId: w.vehicle.id,
      workspaceId: w.ws.id,
      serviceId: w.service.id,
      lastPingAt: new Date(NOW.getTime() - 20_000),
      since: new Date(NOW.getTime() - 20_000),
      lat: 15.6,
      lng: 73.7,
      ...stateOf(w),
    });
  const status = PublicStatus.parse(await publicStatus(db(), w.ws.id, NOW));
  const line = (spotId: string) =>
    status.spots.find((s) => s.spotId === spotId)?.answers.find((a) => a.kind === "live");
  return { w, status, line };
}

describe("public status for a van on the way back of an out-and-back route", () => {
  it("just left Namaka for Circle: Circle is minutes away, never 'here now'", async () => {
    const { w, line } = await withVan((w) => ({
      phase: "en_route",
      spotId: w.id.namaka,
      nextSpotId: w.id.circle,
      alongM: (w.cumM[3] as number) + 200,
      etaS: 100,
    }));
    const circle = line(w.id.circle);
    expect(circle?.phaseText).not.toBe("here now");
    expect(circle?.minutes).toBeGreaterThanOrEqual(1);
    expect(circle?.minutes).toBeLessThanOrEqual(3);
    // then Circle → Riva: the rest of leg 3 (~115 s), a dwell and leg 4, so Riva is several minutes off
    expect(line(w.id.riva)?.minutes).toBeGreaterThanOrEqual(5);
  });

  it("an arrival alert for Circle (1 min lead) does not fire for a van that just left Namaka", async () => {
    const { w } = await withVan((w) => ({
      phase: "en_route",
      spotId: w.id.namaka,
      nextSpotId: w.id.circle,
      alongM: (w.cumM[3] as number) + 200,
    }));
    const person = await makePerson(db(), { firstName: "Asha" });
    const actor = attendee(person, w.ws.id);
    const lead = { workspaceId: w.ws.id, spotId: w.id.circle, leadMin: 1 };
    await subscribeArrival(db(), actor, lead, new Date(NOW.getTime() - 60_000));
    expect(await runArrivalAlerts(db(), { workspaceId: w.ws.id }, NOW)).toEqual({ fired: 0, expired: 0 });
    expect(await db().select().from(outbox).where(eq(outbox.workspaceId, w.ws.id))).toHaveLength(0);
  });

  it("waiting at Circle on the way back (next Riva): Riva is next, Namaka is a long way round", async () => {
    const { w, line } = await withVan((w) => ({
      phase: "at_spot",
      spotId: w.id.circle,
      nextSpotId: w.id.riva,
      alongM: w.cumM[4] as number,
    }));
    expect(line(w.id.circle)?.phaseText).toBe("here now");
    expect(line(w.id.riva)?.minutes).toBeLessThanOrEqual(6);
    expect(line(w.id.namaka)?.minutes).toBeGreaterThan(10);
  });

  it("on the way out (Riva → Circle) the answers are unchanged", async () => {
    const { w, line } = await withVan((w) => ({
      phase: "en_route",
      spotId: w.id.riva,
      nextSpotId: w.id.circle,
      alongM: (w.cumM[1] as number) + 500,
    }));
    expect(line(w.id.circle)?.minutes).toBeGreaterThanOrEqual(1);
    expect(line(w.id.circle)?.minutes).toBeLessThanOrEqual(2);
    expect(line(w.id.namaka)?.minutes).toBeGreaterThanOrEqual(4);
  });

  it("a stop the route passes twice shows both passes in its timetable", async () => {
    const { w, status } = await withVan(
      (w) => ({ phase: "at_spot", spotId: w.id.nanu, nextSpotId: w.id.riva, alongM: 0 }),
      "times",
    );
    const rows = (id: string) => status.spots.find((s) => s.spotId === id)?.schedule.rows.map((r) => r.label);
    // legs of 1 km at the 25 km/h baseline (144 s) and a 3 min dwell per stop: Namaka once, Circle at +9 min and +21 min
    expect(rows(w.id.namaka)).toHaveLength(2); // 09:00, 09:40 once each
    expect(rows(w.id.circle)).toHaveLength(4);
    expect(rows(w.id.riva)).toHaveLength(4);
    expect(rows(w.id.nanu)).toHaveLength(2); // the loop's end is its start
    const names = status.spots.map((s) => s.shortName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each pass of a repeated stop says where it goes; a stop passed once keeps the plain time", async () => {
    const { w, status } = await withVan(
      (w) => ({ phase: "at_spot", spotId: w.id.nanu, nextSpotId: w.id.riva, alongM: 0 }),
      "times",
    );
    const rows = (id: string) => status.spots.find((s) => s.spotId === id)?.schedule.rows ?? [];
    // Circle: out to Namaka about +10.8 min, back to Riva about +21.6 min (legs 144 s, dwells 3 min)
    expect(rows(w.id.circle).map((r) => `${r.label} ${r.serviceName}`)).toEqual([
      "09:10 Loop · to Namaka",
      "09:21 Loop · to Riva",
      "09:50 Loop · to Namaka",
      "10:01 Loop · to Riva",
    ]);
    expect(rows(w.id.riva).every((r) => /^Loop · to (Circle|Nanu)$/.test(r.serviceName))).toBe(true);
    // a stop passed once keeps its plain service name
    expect(rows(w.id.namaka).every((r) => r.serviceName === "Loop")).toBe(true);
    expect(rows(w.id.nanu).every((r) => r.serviceName === "Loop")).toBe(true);
    expect(
      rows(w.id.circle)
        .map((r) => `${r.label} ${r.serviceName}`)
        .join(" "),
    ).not.toMatch(/late|behind|delay/i);
  });
});
