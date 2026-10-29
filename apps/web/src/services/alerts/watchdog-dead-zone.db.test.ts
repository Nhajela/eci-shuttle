// Silent alerts on the REAL desiredConfig / refreshPhases / dead zones / sight():
// - a van silent inside a known no-signal leg is not "silent" until its predicted time there is up;
// - one silent episode alerts once, even when an offline backlog moves last_ping_at forward while still silent.
import { istToEpoch, pathLengthM } from "@eci-shuttle/shared";
import { makeAssignedDevice } from "@tests/factories/alerts";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq, like } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { outbox, routes, services, serviceVehicles, spots, vehicleState } from "@/db/schema";
import { estimateVehicles } from "@/services/public/estimates";
import { detectProblems, runWatchdog } from "./watchdog";

// the real estimateVehicles, wrapped so one test can make it fail
vi.mock("@/services/public/estimates", async (orig) => ({
  estimateVehicles: vi.fn((await orig<typeof import("@/services/public/estimates")>()).estimateVehicles),
}));

const db = () => testDb();
const html = (o?: { payload: unknown }) => (o?.payload as { html?: string } | undefined)?.html ?? "";
const DAY = "2026-10-15";
const at = (hhmm: string, s = 0) => new Date(istToEpoch(DAY, hhmm) + s * 1000);

// a straight path north: Riva (0°) → Circle (0.02°) → Namaka (0.04°), ~2.2 km per leg
const PATH = [0, 0.01, 0.02, 0.03, 0.04].map((lat) => ({ lat, lng: 73 }));
// the van's last fix: on the Circle → Namaka leg, 500 m past Circle
const FIX = { lat: 0.0245, lng: 73 };
const FIX_ALONG = pathLengthM([PATH[0] as (typeof PATH)[number], FIX]);
// Circle → Namaka takes 10 min, so a prediction is believed for 15 min after the last fix

async function setup(opts: { marked: boolean }) {
  const ws = await makeWorkspace(db());
  const { person } = await makeAdmin(db(), ws.id);
  const spotRows = await db()
    .insert(spots)
    .values(
      ["Riva", "Circle", "Namaka"].map((name, i) => ({
        workspaceId: ws.id,
        name,
        shortName: name,
        lat: (PATH[i * 2] as (typeof PATH)[number]).lat,
        lng: 73,
      })),
    )
    .returning();
  const [r] = await db()
    .insert(routes)
    .values({
      workspaceId: ws.id,
      name: "Loop",
      spotIds: spotRows.map((s) => s.id),
      path: PATH,
      spotPathIdx: [0, 2, 4],
      typicalLegS: [600, 600],
      noSignalLegs: opts.marked ? [{ legIndex: 1, source: "manual" }] : [],
    })
    .returning();
  const [svc] = await db()
    .insert(services)
    .values({
      workspaceId: ws.id,
      name: "Riva ↔ Namaka",
      kind: "regular",
      routeId: r.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "08:00",
      endTime: "12:00",
      pattern: { kind: "every", everyMin: 30 },
    })
    .returning();
  const { vehicle } = await makeAssignedDevice(db(), ws.id, {
    device: { lastSyncAt: at("10:00"), reportedMode: "active", reportedConfigVersion: 1 },
    state: {
      serviceId: svc.id,
      phase: "en_route",
      spotId: spotRows[1]?.id,
      nextSpotId: spotRows[2]?.id,
      lastPingAt: at("10:02"),
      lat: FIX.lat,
      lng: FIX.lng,
      alongM: FIX_ALONG,
    },
  });
  await db()
    .insert(serviceVehicles)
    .values({
      workspaceId: ws.id,
      serviceId: svc.id,
      vehicleId: vehicle.id,
      startsAt: at("07:00"),
      endsAt: at("13:00"),
    });
  /** the van reports a fix (what ingest does with a live ping: the phase is live again) */
  const ping = (when: Date) =>
    db()
      .update(vehicleState)
      .set({ phase: "en_route", lastPingAt: when })
      .where(eq(vehicleState.vehicleId, vehicle.id));
  /** an offline backlog batch: the newest fix moves forward, the state stays offline with its episode start */
  const backlog = (when: Date) =>
    db().update(vehicleState).set({ lastPingAt: when }).where(eq(vehicleState.vehicleId, vehicle.id));
  const silentAlerts = async () =>
    (
      await db()
        .select()
        .from(outbox)
        .where(like(outbox.dedupeKey, `alert:silent:${vehicle.id}:%`))
    ).filter((o) => o.workspaceId === ws.id);
  const silentProblems = async (now: Date) =>
    (await detectProblems(db(), ws.id, now)).filter((p) => p.kind === "silent");
  return { ws, person, vehicle, ping, backlog, silentAlerts, silentProblems };
}

describe("silent inside a marked no-signal leg", () => {
  it("raises nothing while the prediction stands, then one alert (since the last fix) once it expires", async () => {
    const t = await setup({ marked: true });
    await runWatchdog(db(), at("10:08")); // 6 min silent
    await runWatchdog(db(), at("10:14")); // 12 min
    expect(await t.silentAlerts()).toHaveLength(0);
    expect(await t.silentProblems(at("10:14"))).toHaveLength(0);

    await runWatchdog(db(), at("10:18")); // 16 min > 1.5 × 10 min
    const alerts = await t.silentAlerts();
    expect(alerts).toHaveLength(1);
    expect(html(alerts[0])).toContain("Since 10:02");
    expect(await t.silentProblems(at("10:18"))).toContainEqual(expect.objectContaining({ since: at("10:02") }));

    await runWatchdog(db(), at("10:19"));
    expect(await t.silentAlerts()).toHaveLength(1);
  });

  it("a van silent on an unmarked leg alerts as before", async () => {
    const t = await setup({ marked: false });
    await runWatchdog(db(), at("10:08"));
    const alerts = await t.silentAlerts();
    expect(alerts).toHaveLength(1);
    expect(html(alerts[0])).toContain("Since 10:02");
  });

  it("a marked leg does not hide a van whose last fix was off that leg", async () => {
    const t = await setup({ marked: true });
    // last seen well before the marked leg (on Riva → Circle)
    await db()
      .update(vehicleState)
      .set({ lat: 0.005, alongM: pathLengthM([PATH[0] as (typeof PATH)[number], { lat: 0.005, lng: 73 }]) })
      .where(eq(vehicleState.vehicleId, t.vehicle.id));
    await runWatchdog(db(), at("10:08"));
    expect(await t.silentAlerts()).toHaveLength(1);
  });
});

describe("one silent episode, one alert", () => {
  it("a backlog moving last_ping_at forward by seconds while still silent does not alert again", async () => {
    const t = await setup({ marked: false });
    await runWatchdog(db(), at("10:08"));
    expect(await t.silentAlerts()).toHaveLength(1);

    await t.backlog(at("10:02", 40)); // first batch of the offline backlog, still > 5 min old
    await runWatchdog(db(), at("10:14"));
    await t.backlog(at("10:03", 30)); // next batch
    await runWatchdog(db(), at("10:15"));
    expect(await t.silentAlerts()).toHaveLength(1);
  });

  it("alerts again for a new silence after the vehicle was live again", async () => {
    const t = await setup({ marked: false });
    await runWatchdog(db(), at("10:08"));
    await t.ping(at("10:12"));
    await runWatchdog(db(), at("10:13")); // live again: the episode is over
    expect(await t.silentProblems(at("10:13"))).toHaveLength(0);
    await runWatchdog(db(), at("10:20")); // silent again since 10:12
    const alerts = await t.silentAlerts();
    expect(alerts).toHaveLength(2);
    expect(html(alerts[1])).toContain("Since 10:12");
  });

  it("the live board / problem list shows the same silent problem with its last fix as since", async () => {
    const t = await setup({ marked: false });
    await runWatchdog(db(), at("10:08"));
    await t.backlog(at("10:02", 40));
    expect(await t.silentProblems(at("10:14"))).toEqual([expect.objectContaining({ since: at("10:02", 40) })]);
  });
});

describe("when the dead-zone lookup fails", () => {
  it("still reports every problem (alerts fail open, not closed)", async () => {
    const t = await setup({ marked: true });
    vi.mocked(estimateVehicles).mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const problems = await detectProblems(db(), t.ws.id, at("10:08"));
    expect(problems).toContainEqual(expect.objectContaining({ kind: "silent", vehicleId: t.vehicle.id }));
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
