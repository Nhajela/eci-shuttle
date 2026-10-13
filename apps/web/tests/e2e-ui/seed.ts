/**
 * Seeds a live workspace with enough data that every admin page and the public page render real content: two spots,
 * a route, a service running all day today, a vehicle with a paired phone, and a notice. Everything goes through the
 * services, as admin would; only `is_live` is set by hand (no service sets it, by design).
 */
import { istDate } from "@eci-shuttle/shared";
import { makeAdmin } from "@tests/factories/core";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaces } from "@/db/schema";
import { createRoute } from "@/services/catalog/routes";
import { assignServiceVehicle, createService } from "@/services/catalog/schedule";
import { createSpot } from "@/services/catalog/spots";
import { createVehicle } from "@/services/catalog/vehicles";
import { createWorkspace } from "@/services/catalog/workspaces";
import { createPairingCode, pairDevice } from "@/services/devices/pairing";
import { assignPhone } from "@/services/devices/phones";
import { systemActor } from "@/services/kernel";
import { createNotice } from "@/services/notices/notices";

export async function seed(db: Db, now = new Date()) {
  const slug = `ui-${crypto.randomUUID().slice(0, 8)}`;
  const ws = await createWorkspace(db, systemActor("e2e-ui"), { slug, name: "Edge City India (UI test)" });
  await db.update(workspaces).set({ isLive: true }).where(eq(workspaces.id, ws.id));
  const workspaceId = ws.id;
  const { person, actor } = await makeAdmin(db, workspaceId);

  const riva = await createSpot(db, actor, {
    workspaceId,
    name: "Riva Beach Resort",
    shortName: "Riva",
    lat: 15.6553,
    lng: 73.7152,
  });
  const circle = await createSpot(db, actor, {
    workspaceId,
    name: "The Circle",
    shortName: "Circle",
    lat: 15.664,
    lng: 73.7185,
  });
  // OSRM is never called from tests: a failing fetch → straight segments
  const route = await createRoute(
    db,
    actor,
    { workspaceId, name: "Riva ↔ Circle", spotIds: [riva.id, circle.id, riva.id] },
    { fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch },
  );
  const day = istDate(now);
  const service = await createService(db, actor, {
    workspaceId,
    name: "Riva ↔ Circle shuttle",
    kind: "regular",
    routeId: route.id,
    validFrom: day,
    validTo: day,
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    startTime: "00:00",
    endTime: "23:59",
    pattern: { kind: "times", times: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"] },
  });
  const vehicle = await createVehicle(db, actor, { workspaceId, name: "Shuttle 1" });
  await assignServiceVehicle(db, actor, {
    workspaceId,
    serviceId: service.id,
    vehicleId: vehicle.id,
    startsAt: new Date(now.getTime() - 3_600_000).toISOString(),
    endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });

  const { code } = await createPairingCode(db, actor, { workspaceId, label: "Driver phone" }, now);
  const paired = await pairDevice(
    db,
    { code, model: "Pixel 7", appVersion: "1.0.0", updateId: null, pushToken: null },
    now,
  );
  await assignPhone(db, actor, { workspaceId, deviceId: paired.deviceId, vehicleId: vehicle.id });

  await createNotice(db, actor, {
    workspaceId,
    text: "Road works near the Circle: pickups move 50 m north until Friday.",
    severity: "heads_up",
    placements: ["everywhere"],
  });

  return { slug, personId: person.id };
}
