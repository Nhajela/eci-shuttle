/**
 * End to end on the local Docker Postgres (SPEC §3 "simulated device", §4, §6): a test workspace with Riva and
 * Circle, a route, a timed service, a vehicle and a simulated phone paired through POST /api/device/pair. The
 * phone's trip is replayed through the real POST /api/device/sync handler (sync → ingest → vehicle_state), and
 * attendees' answers are read from the real GET /api/status handler. Setup and ops actions go through the
 * services, as admin would. Time is a fake system clock, since the route handlers read `new Date()`.
 */
import {
  type AnswerLine,
  istToEpoch,
  type LatLng,
  type Ping,
  type PublicStatus,
  resolveMode,
  type SyncRequest,
  type SyncResponse,
} from "@eci-shuttle/shared";
import { makeAdmin } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as pairRoute } from "@/app/api/device/pair/route";
import { POST as syncRoute } from "@/app/api/device/sync/route";
import { GET as statusRoute } from "@/app/api/status/route";
import { auditLog, pings } from "@/db/schema";
import { createRoute } from "@/services/catalog/routes";
import { assignServiceVehicle, createService } from "@/services/catalog/schedule";
import { createSpot } from "@/services/catalog/spots";
import { createVehicle } from "@/services/catalog/vehicles";
import { createWorkspace } from "@/services/catalog/workspaces";
import { createPairingCode } from "@/services/devices/pairing";
import { assignPhone, killPhone, silencePhone } from "@/services/devices/phones";
import { systemActor } from "@/services/kernel";

const db = () => testDb();

/** Riva Beach Resort, Mandrem. */
const RIVA: LatLng = { lat: 15.6553, lng: 73.7152 };
/** PLACEHOLDER for "Circle": a plausible junction ~1 km north of Riva. Replace with the real pin when known. */
const CIRCLE: LatLng = { lat: 15.664, lng: 73.7185 };

const DAY = "2026-10-14"; // a Wednesday
const at = (hhmm: string) => istToEpoch(DAY, hhmm);
const MIN = 60_000;
/** the phone's GPS interval and how often it uploads (well inside the 12/min sync rate limit) */
const FIX_MS = 10_000;
const SYNC_MS = 30_000;

const lerp = (a: LatLng, b: LatLng, f: number): LatLng => ({
  lat: a.lat + (b.lat - a.lat) * f,
  lng: a.lng + (b.lng - a.lng) * f,
});

/** Builds the world through the services, then pairs a simulated phone through the real pair route. */
async function setup() {
  vi.setSystemTime(at("08:00"));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const ws = await createWorkspace(db(), systemActor("e2e"), { slug, name: "E2E test" });
  const { actor } = await makeAdmin(db(), ws.id);
  const workspaceId = ws.id;
  const riva = await createSpot(db(), actor, { workspaceId, name: "Riva", shortName: "Riva", ...RIVA });
  const circle = await createSpot(db(), actor, { workspaceId, name: "Circle", shortName: "Circle", ...CIRCLE });
  // OSRM is never called from tests: a failing fetch → straight segments
  const route = await createRoute(
    db(),
    actor,
    { workspaceId, name: "Riva ↔ Circle", spotIds: [riva.id, circle.id, riva.id] },
    { fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch },
  );
  const service = await createService(db(), actor, {
    workspaceId,
    name: "Riva ↔ Circle",
    kind: "regular",
    routeId: route.id,
    validFrom: DAY,
    validTo: DAY,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: "08:30",
    endTime: "11:00",
    pattern: { kind: "times", times: ["09:00", "09:30", "10:00", "10:30"] },
  });
  const vehicle = await createVehicle(db(), actor, { workspaceId, name: "Shuttle 1" });
  await assignServiceVehicle(db(), actor, {
    workspaceId,
    serviceId: service.id,
    vehicleId: vehicle.id,
    startsAt: new Date(at("08:30")).toISOString(),
    endsAt: new Date(at("11:00")).toISOString(),
  });

  const { code } = await createPairingCode(db(), actor, { workspaceId, label: "Sim phone" }, new Date());
  const res = await pairRoute(
    post("/api/device/pair", { code, model: "sim", appVersion: "sim", updateId: null, pushToken: null }),
  );
  expect(res.status).toBe(200);
  const { deviceId, token, config } = (await res.json()) as { deviceId: string; token: string; config: SyncResponse };
  expect(config.workspace.slug).toBe(slug);
  await assignPhone(db(), actor, { workspaceId, deviceId, vehicleId: vehicle.id });

  const phone = makePhone(token, config);
  /** the attendee's answer at a spot, from GET /api/status at the current (fake) time */
  const answer = async (spot: "Riva" | "Circle"): Promise<AnswerLine> => {
    const r = await statusRoute(new Request(`http://localhost/api/status?w=${slug}`));
    expect(r.status).toBe(200);
    const s = (await r.json()) as PublicStatus;
    const line = s.spots.find((x) => x.name === spot)?.answers[0];
    expect(line, `${spot} has an answer`).toBeDefined();
    return line as AnswerLine;
  };
  return { actor, workspaceId, deviceId, vehicle, phone, answer };
}

const post = (path: string, body: unknown, token?: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** A simulated phone speaking the device protocol to the real sync handler. */
function makePhone(token: string, initial: SyncResponse) {
  let config = initial;
  const sync = async (batch: Ping[], extra: Partial<SyncRequest> = {}) => {
    const now = Date.now();
    const body: SyncRequest = {
      pings: batch,
      battery: 80,
      charging: true,
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
      reportedMode: resolveMode(config, now).mode,
      appliedConfigVersion: config.configVersion,
      appVersion: "sim",
      updateId: null,
      clock: now,
      ...extra,
    };
    const r = await syncRoute(post("/api/device/sync", body, token));
    expect(r.status, await r.clone().text()).toBe(200);
    config = (await r.json()) as SyncResponse;
    return config;
  };
  return {
    sync,
    config: () => config,
    /** GPS every 10 s from `from` to `to` (fake clock follows), uploading every 30 s like the app. */
    async drive(from: number, to: number, where: (t: number) => LatLng) {
      let queue: Ping[] = [];
      let lastSync = from;
      for (let t = from; t <= to; t += FIX_MS) {
        vi.setSystemTime(t);
        queue.push({ recordedAt: t, ...where(t), accuracy: 8, speed: null, heading: null, battery: 80 });
        if (t - lastSync >= SYNC_MS || t + FIX_MS > to) {
          await sync(queue);
          queue = [];
          lastSync = t;
        }
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("e2e: a simulated phone drives Riva → Circle", () => {
  it("the answer at Circle goes timetable → live 'here in N min' → here now", async () => {
    const { phone, answer } = await setup();

    // 08:40, nothing live yet: the timetable answer
    vi.setSystemTime(at("08:40"));
    expect(resolveMode(phone.config(), Date.now()).mode).toBe("idle"); // no vehicle when it paired
    await phone.sync([]);
    expect(resolveMode(phone.config(), Date.now()).mode).toBe("active"); // 08:30 −15 min window, after assign
    const before = await answer("Circle");
    expect(before.kind).toBe("timetable");
    expect(before.minutes).toBeNull();
    expect((await answer("Riva")).nextAtLabel).toBe("09:00");

    // waiting at Riva 08:50–09:00: Riva says here now, Circle is live with an ETA
    await phone.drive(at("08:50"), at("09:00"), () => RIVA);
    const rivaNow = await answer("Riva");
    expect(rivaNow).toMatchObject({ kind: "live", minutes: 0, phaseText: "here now", vehicleName: "Shuttle 1" });
    const waiting = await answer("Circle");
    expect(waiting.kind).toBe("live");
    expect(waiting.minutes).toBeGreaterThan(0);

    // 09:00 leaves Riva, ~1 km at ~25 km/h: halfway there, Circle says "here in N min", fewer than before
    const leg = 150_000;
    const toward = (t: number) => lerp(RIVA, CIRCLE, Math.min(1, (t - at("09:00")) / leg));
    await phone.drive(at("09:00") + FIX_MS, at("09:00") + leg / 2, toward);
    const coming = await answer("Circle");
    expect(coming.kind).toBe("live");
    expect(coming.phaseText).not.toBe("here now");
    expect(coming.minutes).toBeGreaterThan(0);
    expect(coming.minutes).toBeLessThan(waiting.minutes as number);
    expect(coming.lastSeenS).toBeLessThanOrEqual(30);
    // attendees never see lateness
    expect(JSON.stringify(coming)).not.toMatch(/late|behind/i);

    // arrives and stays past the geofence dwell: here now
    await phone.drive(at("09:00") + leg / 2 + FIX_MS, at("09:00") + leg + MIN, toward);
    expect(await answer("Circle")).toMatchObject({ kind: "live", minutes: 0, phaseText: "here now" });
  });

  it("kill stops the phone and the answer falls back to the timetable; Resume brings it back live", async () => {
    const { actor, workspaceId, deviceId, phone, answer } = await setup();
    await phone.drive(at("09:05"), at("09:07"), () => CIRCLE);
    expect((await answer("Circle")).phaseText).toBe("here now");

    await killPhone(db(), actor, { workspaceId, deviceId });
    vi.setSystemTime(at("09:07") + 15_000);
    const killed = await phone.sync([]);
    expect(killed.killed).toBe(true);
    expect(resolveMode(killed, Date.now()).mode).toBe("killed");

    // a stray upload from a killed phone is dropped, so it goes stale: no live answer pretends otherwise
    const strayAt = at("09:08");
    vi.setSystemTime(strayAt);
    await phone.sync([{ recordedAt: strayAt, ...CIRCLE, accuracy: 8, speed: null, heading: null, battery: 80 }]);
    const stray = await db()
      .select()
      .from(pings)
      .where(and(eq(pings.deviceId, deviceId), eq(pings.recordedAt, new Date(strayAt))));
    expect(stray).toHaveLength(0);
    vi.setSystemTime(at("09:10"));
    expect((await answer("Circle")).kind).toBe("timetable");

    // the driver presses Resume: audited with the device as actor, and live again on the next pings
    vi.setSystemTime(at("09:11"));
    const resumed = await phone.sync([], { resume: true });
    expect(resumed.killed).toBe(false);
    expect(resolveMode(resumed, Date.now()).mode).toBe("active");
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, deviceId), eq(auditLog.action, "device.resume")));
    expect(audit).toMatchObject({ actorKind: "device", actorId: deviceId });
    await phone.drive(at("09:11") + FIX_MS, at("09:12"), () => CIRCLE);
    expect(await answer("Circle")).toMatchObject({ kind: "live", phaseText: "here now" });
  });

  it("silence puts the phone idle inside its window until it ends; meanwhile the answer is the timetable", async () => {
    const { actor, workspaceId, deviceId, phone, answer } = await setup();
    await phone.drive(at("09:05"), at("09:07"), () => CIRCLE);
    expect((await answer("Circle")).kind).toBe("live");

    await silencePhone(db(), actor, { workspaceId, deviceId, until: new Date(at("09:40")).toISOString() });
    vi.setSystemTime(at("09:07") + 15_000);
    const cfg = await phone.sync([]);
    expect(resolveMode(cfg, Date.now()).mode).toBe("idle");
    expect(resolveMode(cfg, at("09:39")).mode).toBe("idle");
    expect(resolveMode(cfg, at("09:41")).mode).toBe("active");

    // an idle phone sends no GPS: after 2 min the answer is the timetable, never a stale "live"
    vi.setSystemTime(at("09:20"));
    await phone.sync([]);
    const quiet = await answer("Circle");
    expect(quiet.kind).toBe("timetable");
    expect(quiet.minutes).toBeNull();

    // the silence ends on its own: the phone tracks again and the answer is live
    await phone.drive(at("09:41"), at("09:42"), () => CIRCLE);
    expect((await answer("Circle")).kind).toBe("live");
  });
});
