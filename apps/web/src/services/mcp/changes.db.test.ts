import { randomUUID } from "node:crypto";
import type { McpChange } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  deviceAssignments,
  devices,
  notices,
  routes,
  serviceExceptions,
  services,
  serviceVehicles,
  spots,
  vehicleState,
  vehicles,
  workspaces,
} from "@/db/schema";
import type { ServiceError, ServiceErrorCode } from "../kernel";
import { actorFor, applyChange, changeWarnings, describeChange, liveBoard, loadVersions, versionKeys } from "./changes";

const db = () => testDb();
const NOW = new Date("2026-10-12T04:50:00Z"); // Mon 12 Oct, 10:20 IST
const DAY = "2026-10-12";

async function expectCode(p: Promise<unknown>, code: ServiceErrorCode) {
  await expect(p).rejects.toMatchObject({ code } satisfies Partial<ServiceError>);
}

/** Riva → Circle → Riva, "Morning" every 20 min 10:00–11:00 IST, Bus 1 on it now with "Ravi's Redmi". */
async function setup(role: "admin" | "ops" | "viewer" = "admin") {
  const ws = await makeWorkspace(db());
  const { actor, person } = await makeAdmin(db(), ws.id, role, "mcp");
  const [riva, circle] = await db()
    .insert(spots)
    .values([
      { workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 },
      { workspaceId: ws.id, name: "Circle", shortName: "Circle", lat: 15.61, lng: 73.71 },
    ])
    .returning();
  const [route] = await db()
    .insert(routes)
    .values({ workspaceId: ws.id, name: "Riva ↔ Circle", spotIds: [riva.id, circle.id, riva.id] })
    .returning();
  const [service] = await db()
    .insert(services)
    .values({
      workspaceId: ws.id,
      name: "Morning",
      kind: "regular",
      routeId: route.id,
      validFrom: "2026-10-10",
      validTo: "2026-10-20",
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTime: "10:00",
      endTime: "11:00",
      pattern: { kind: "every", everyMin: 20 },
    })
    .returning();
  const [bus] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Bus 1" }).returning();
  const [phone] = await db()
    .insert(devices)
    .values({ workspaceId: ws.id, label: "Ravi's Redmi", tokenHash: randomUUID() })
    .returning();
  await db()
    .insert(deviceAssignments)
    .values({ workspaceId: ws.id, deviceId: phone.id, vehicleId: bus.id, startsAt: new Date("2026-10-01T00:00:00Z") });
  const [sv] = await db()
    .insert(serviceVehicles)
    .values({
      workspaceId: ws.id,
      serviceId: service.id,
      vehicleId: bus.id,
      startsAt: new Date("2026-10-12T04:00:00Z"),
      endsAt: new Date("2026-10-12T06:00:00Z"),
    })
    .returning();
  return { ws, actor, person, riva, circle, route, service, bus, phone, sv };
}

const cancel1020 = (serviceId: string): Extract<McpChange, { kind: "service.exception" }> => ({
  kind: "service.exception",
  serviceId,
  date: DAY,
  type: "cancel_departure",
  departure: "10:20",
  minutes: null,
  note: null,
});

describe("versionKeys", () => {
  const id = randomUUID();
  it("names the object each change depends on, none for creates", () => {
    expect(versionKeys({ kind: "spot.update", spotId: id })).toEqual([`spot:${id}`]);
    expect(versionKeys({ kind: "spot.archive", spotId: id })).toEqual([`spot:${id}`]);
    expect(versionKeys({ kind: "route.update", routeId: id })).toEqual([`route:${id}`]);
    expect(versionKeys({ kind: "service.update", serviceId: id })).toEqual([`service:${id}`]);
    expect(versionKeys(cancel1020(id))).toEqual([`service:${id}`]);
    expect(
      versionKeys({ kind: "service_vehicle.assign", serviceId: id, vehicleId: randomUUID(), startsAt: "", endsAt: "" }),
    ).toEqual([`service:${id}`]);
    expect(versionKeys({ kind: "service_vehicle.unassign", serviceVehicleId: id })).toEqual([`service_vehicle:${id}`]);
    expect(versionKeys({ kind: "vehicle.update", vehicleId: id })).toEqual([`vehicle:${id}`]);
    expect(versionKeys({ kind: "phone.kill", deviceId: id })).toEqual([`device:${id}`]);
    expect(versionKeys({ kind: "phone.move_workspace", deviceId: id, toWorkspaceId: randomUUID() })).toEqual([
      `device:${id}`,
    ]);
    expect(versionKeys({ kind: "notice.end", noticeId: id })).toEqual([`notice:${id}`]);
    expect(
      versionKeys({ kind: "vehicle.create", name: "V", plate: null, colour: null, capacity: null, active: true }),
    ).toEqual([]);
    expect(versionKeys({ kind: "pairing_code.create", label: null })).toEqual([]);
    expect(versionKeys({ kind: "workspace.create", slug: "x1", name: "X" })).toEqual([]);
  });
});

describe("loadVersions", () => {
  it("reads each key's current version in the workspace", async () => {
    const { ws, riva, service, phone } = await setup();
    await db().update(spots).set({ version: 3 }).where(eq(spots.id, riva.id));
    expect(await loadVersions(db(), ws.id, [`spot:${riva.id}`, `service:${service.id}`, `device:${phone.id}`])).toEqual(
      {
        [`spot:${riva.id}`]: 3,
        [`service:${service.id}`]: 1,
        [`device:${phone.id}`]: 1,
      },
    );
  });

  it("NOT_FOUND for a missing or foreign object, INVALID for an unknown entity", async () => {
    const a = await setup();
    const b = await setup();
    await expectCode(loadVersions(db(), a.ws.id, [`spot:${b.riva.id}`]), "NOT_FOUND");
    await expectCode(loadVersions(db(), a.ws.id, [`notice:${randomUUID()}`]), "NOT_FOUND");
    await expectCode(loadVersions(db(), a.ws.id, [`person:${randomUUID()}`]), "INVALID");
  });

  it("forUpdate locks the rows until the transaction ends", async () => {
    const { ws, riva } = await setup();
    const err = await db().transaction(async (tx) => {
      await loadVersions(tx, ws.id, [`spot:${riva.id}`], { forUpdate: true });
      return db()
        .execute(sql`select id from spots where id = ${riva.id} for update nowait`)
        .then(
          () => "not locked",
          (e: { cause?: unknown }) => String(e.cause ?? e),
        );
    });
    expect(err).toMatch(/could not obtain lock/);
  });
});

describe("describeChange", () => {
  it("names objects and gives times in IST", async () => {
    const { ws, riva, circle, route, service, bus, phone, sv } = await setup();
    const d = (c: McpChange) => describeChange(db(), ws.id, c);
    expect(await d(cancel1020(service.id))).toBe("Cancel the 10:20 departure of 'Morning' on Mon 12 Oct");
    expect(await d({ ...cancel1020(service.id), type: "cancel_day", departure: null })).toBe(
      "Cancel all of 'Morning' on Mon 12 Oct",
    );
    expect(await d({ ...cancel1020(service.id), type: "add_departure", departure: "10:50" })).toBe(
      "Add a 10:50 departure to 'Morning' on Mon 12 Oct",
    );
    expect(await d({ ...cancel1020(service.id), type: "shift_minutes", minutes: -5 })).toBe(
      "Move the 10:20 departure of 'Morning' on Mon 12 Oct 5 min earlier",
    );
    expect(await d({ kind: "phone.kill", deviceId: phone.id })).toBe("Kill phone 'Ravi's Redmi' (Bus 1)");
    expect(await d({ kind: "phone.assign", deviceId: phone.id, vehicleId: null })).toBe(
      "Take phone 'Ravi's Redmi' out of Bus 1",
    );
    expect(await d({ kind: "phone.silence", deviceId: phone.id, until: "2026-10-12T07:30:00Z" })).toBe(
      "Silence phone 'Ravi's Redmi' (Bus 1) until Mon 12 Oct, 13:00",
    );
    expect(await d({ kind: "route.create", name: "Loop", spotIds: [riva.id, circle.id, riva.id] })).toBe(
      "Add route 'Loop': Riva → Circle → Riva",
    );
    expect(await d({ kind: "route.update", routeId: route.id, name: "Beach loop", regeneratePath: true })).toBe(
      "Change route 'Riva ↔ Circle': name 'Beach loop', regenerate the path",
    );
    expect(await d({ kind: "route.update", routeId: route.id, plannedDwellS: { "*": 300 } })).toBe(
      "Change route 'Riva ↔ Circle': wait 5 min at each stop",
    );
    expect(
      await d({ kind: "route.update", routeId: route.id, plannedDwellS: { "*": 300, [circle.id]: 90, [riva.id]: 0 } }),
    ).toBe("Change route 'Riva ↔ Circle': wait 5 min at each stop, 1.5 min at Circle, no wait at Riva");
    expect(await d({ kind: "route.update", routeId: route.id, plannedDwellS: { [circle.id]: 120 } })).toBe(
      "Change route 'Riva ↔ Circle': wait 2 min at Circle",
    );
    expect(await d({ kind: "route.update", routeId: route.id, plannedDwellS: {} })).toBe(
      "Change route 'Riva ↔ Circle': no planned wait at stops",
    );
    expect(await d({ kind: "spot.update", spotId: riva.id, name: "Riva Beach", radiusM: 80, notes: null })).toBe(
      "Change spot 'Riva': name 'Riva Beach', radius 80 m, clear notes",
    );
    expect(await d({ kind: "spot.archive", spotId: circle.id })).toBe("Archive spot 'Circle'");
    expect(
      await d({
        kind: "service_vehicle.assign",
        serviceId: service.id,
        vehicleId: bus.id,
        startsAt: "2026-10-13T04:00:00Z",
        endsAt: "2026-10-13T06:00:00Z",
      }),
    ).toBe("Put Bus 1 on 'Morning' from Tue 13 Oct, 09:30 to Tue 13 Oct, 11:30");
    expect(await d({ kind: "service_vehicle.unassign", serviceVehicleId: sv.id })).toBe(
      "Take Bus 1 off 'Morning' (Mon 12 Oct, 09:30 to Mon 12 Oct, 11:30)",
    );
    expect(
      await d({
        kind: "notice.create",
        text: "The 10:20 is cancelled",
        severity: "heads_up",
        pinned: false,
        sort: 0,
        startsAt: null,
        endsAt: "2026-10-12T05:15:00Z",
        placements: ["everywhere"],
        channels: ["group"],
      }),
    ).toBe(
      'Post a heads-up notice "The 10:20 is cancelled" from now until Mon 12 Oct, 10:45 (also to the Telegram group)',
    );
    expect(await d({ kind: "pairing_code.create", label: "Bus 2" })).toBe(
      "Make a pairing code for a new phone 'Bus 2'",
    );
    expect(await d({ kind: "workspace.create", slug: "rehearsal", name: "Rehearsal" })).toBe(
      "Create workspace 'Rehearsal' (rehearsal)",
    );
  });

  it("NOT_FOUND when a referenced object isn't in the workspace", async () => {
    const a = await setup();
    const b = await setup();
    await expectCode(describeChange(db(), a.ws.id, { kind: "phone.kill", deviceId: b.phone.id }), "NOT_FOUND");
  });
});

describe("changeWarnings", () => {
  it("warns when a cancel leaves the first spot without a shuttle", async () => {
    const { ws, service } = await setup();
    expect(await changeWarnings(db(), ws.id, [cancel1020(service.id)], NOW)).toEqual([
      "Cancelling this leaves Riva without a shuttle 10:00–10:40 on Mon 12 Oct.",
    ]);
    expect(
      await changeWarnings(db(), ws.id, [{ ...cancel1020(service.id), type: "cancel_day", departure: null }], NOW),
    ).toEqual(["Cancelling this leaves Riva without a shuttle all day on Mon 12 Oct."]);
  });

  it("counts other services on the route when measuring the gap", async () => {
    const { ws, route, service } = await setup();
    const extra = (times: string[]) =>
      db()
        .insert(services)
        .values({
          workspaceId: ws.id,
          name: `Extra ${times.join(",")}`,
          kind: "regular",
          routeId: route.id,
          validFrom: "2026-10-10",
          validTo: "2026-10-20",
          daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
          startTime: times[0],
          endTime: times[times.length - 1],
          pattern: { kind: "times", times },
        });
    const cancelDay = { ...cancel1020(service.id), type: "cancel_day" as const, departure: null };
    // Extra at 10:30 only: Morning's 10:00–11:00 sit on both sides of it
    await extra(["10:30"]);
    expect(await changeWarnings(db(), ws.id, [cancelDay], NOW)).toEqual([
      "Cancelling this leaves Riva without a shuttle until 10:30 and after 10:30 on Mon 12 Oct.",
    ]);
    expect(await changeWarnings(db(), ws.id, [cancel1020(service.id)], NOW)).toEqual([
      "Cancelling this leaves Riva without a shuttle 10:00–10:30 on Mon 12 Oct.",
    ]);
    // with 09:40 and 11:00 too, the 10:30 still splits the day
    await extra(["09:40", "11:00"]);
    expect(await changeWarnings(db(), ws.id, [cancelDay], NOW)).toEqual([
      "Cancelling this leaves Riva without a shuttle 09:40–10:30 and 10:30–11:00 on Mon 12 Oct.",
    ]);
  });

  it("warns about phones and vehicles running right now", async () => {
    const { ws, phone, sv, bus } = await setup();
    expect(await changeWarnings(db(), ws.id, [{ kind: "phone.kill", deviceId: phone.id }], NOW)).toEqual([
      "Phone 'Ravi's Redmi' is in Bus 1, which is running 'Morning' right now.",
    ]);
    expect(
      await changeWarnings(db(), ws.id, [{ kind: "service_vehicle.unassign", serviceVehicleId: sv.id }], NOW),
    ).toEqual(["Bus 1 is running 'Morning' right now."]);
    expect(
      await changeWarnings(db(), ws.id, [{ kind: "vehicle.update", vehicleId: bus.id, active: false }], NOW),
    ).toEqual(["Bus 1 is running 'Morning' right now."]);
    // later in the day nothing is running
    expect(
      await changeWarnings(db(), ws.id, [{ kind: "phone.kill", deviceId: phone.id }], new Date("2026-10-12T09:00:00Z")),
    ).toEqual([]);
  });

  it("warns that a group notice won't post while the workspace has no Telegram group", async () => {
    const { ws } = await setup();
    const notice = (channels: ("subscribers" | "group" | "group_pin")[]): McpChange => ({
      kind: "notice.create",
      text: "Hi",
      severity: "info",
      pinned: false,
      sort: 0,
      startsAt: null,
      endsAt: null,
      placements: ["everywhere"],
      channels,
    });
    const warning =
      "This workspace has no Telegram group yet, so nothing is posted to a group. An admin can send /setgroup in the group.";
    expect(await changeWarnings(db(), ws.id, [notice(["subscribers", "group"])], NOW)).toEqual([warning]);
    expect(await changeWarnings(db(), ws.id, [notice(["group_pin"])], NOW)).toEqual([warning]);
    expect(await changeWarnings(db(), ws.id, [notice(["subscribers"])], NOW)).toEqual([]);
    await db().update(workspaces).set({ groupChatId: -100123 }).where(eq(workspaces.id, ws.id));
    expect(await changeWarnings(db(), ws.id, [notice(["group"])], NOW)).toEqual([]);
  });

  it("warns about notices that end before they start or before now, and past dates", async () => {
    const { ws, service } = await setup();
    const notice = (startsAt: string | null, endsAt: string | null): McpChange => ({
      kind: "notice.create",
      text: "Hi",
      severity: "info",
      pinned: false,
      sort: 0,
      startsAt,
      endsAt,
      placements: ["everywhere"],
      channels: [],
    });
    expect(await changeWarnings(db(), ws.id, [notice("2026-10-12T06:00:00Z", "2026-10-12T05:00:00Z")], NOW)).toEqual([
      "Notice ends before it starts.",
    ]);
    expect(await changeWarnings(db(), ws.id, [notice(null, "2026-10-12T04:00:00Z")], NOW)).toEqual([
      "Notice ends before now, so nobody will see it.",
    ]);
    expect(
      await changeWarnings(
        db(),
        ws.id,
        [{ ...cancel1020(service.id), type: "add_departure", date: "2026-10-11" }],
        NOW,
      ),
    ).toEqual(["Sun 11 Oct is in the past."]);
    expect(await changeWarnings(db(), ws.id, [notice(null, null)], NOW)).toEqual([]);
  });
});

describe("applyChange", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs every change kind through its service, each audited with the proposal id", async () => {
    // route.* would call OSRM: fail it so the path falls back to straight segments
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    const s = await setup("admin");
    const other = await makeWorkspace(db());
    await db().execute(
      sql`insert into memberships (person_id, workspace_id, role) values (${s.person.id}, ${other.id}, 'admin')`,
    );
    const actor = { ...s.actor, proposalId: "P-TESTTEST", reason: "test" };
    const [phone2] = await db()
      .insert(devices)
      .values({ workspaceId: s.ws.id, label: "Spare", tokenHash: randomUUID() })
      .returning();
    const [phone3] = await db()
      .insert(devices)
      .values({ workspaceId: s.ws.id, label: "Old", tokenHash: randomUUID() })
      .returning();
    const [notice] = await db()
      .insert(notices)
      .values({ workspaceId: s.ws.id, text: "Old notice", placements: ["everywhere"] })
      .returning();
    const apply = (c: McpChange) => applyChange(db(), actor, s.ws.id, c, NOW);

    const spot = (await apply({
      kind: "spot.create",
      name: "Mandrem",
      shortName: "Mandrem",
      lat: 15.62,
      lng: 73.72,
      radiusM: 75,
      notes: null,
      photoUrl: null,
    })) as { id: string };
    await apply({ kind: "spot.update", spotId: spot.id, name: "Mandrem Beach" });
    await apply({ kind: "spot.archive", spotId: spot.id });
    const route = (await apply({ kind: "route.create", name: "Short", spotIds: [s.riva.id, s.circle.id] })) as {
      id: string;
    };
    await apply({ kind: "route.update", routeId: route.id, name: "Short hop" });
    const svc = (await apply({
      kind: "service.create",
      name: "Evening",
      routeId: route.id,
      public: true,
      colour: null,
      validFrom: "2026-10-12",
      validTo: "2026-10-20",
      daysOfWeek: [1, 2, 3],
      startTime: "18:00",
      endTime: "20:00",
      pattern: { kind: "every", everyMin: 30 },
      serviceKind: "special",
    })) as { id: string; kind: string };
    expect(svc.kind).toBe("special");
    const upd = (await apply({
      kind: "service.update",
      serviceId: svc.id,
      name: "Late evening",
      serviceKind: "regular",
    })) as { kind: string };
    expect(upd.kind).toBe("regular");
    await apply(cancel1020(s.service.id));
    const van = (await apply({
      kind: "vehicle.create",
      name: "Van",
      plate: null,
      colour: null,
      capacity: 8,
      active: true,
    })) as { id: string };
    await apply({ kind: "vehicle.update", vehicleId: van.id, capacity: 9 });
    const sv = (await apply({
      kind: "service_vehicle.assign",
      serviceId: svc.id,
      vehicleId: van.id,
      startsAt: "2026-10-12T12:30:00Z",
      endsAt: "2026-10-12T14:30:00Z",
    })) as { id: string };
    await apply({ kind: "service_vehicle.unassign", serviceVehicleId: sv.id });
    await apply({ kind: "phone.label", deviceId: phone2.id, label: "Spare Nokia" });
    await apply({ kind: "phone.assign", deviceId: phone2.id, vehicleId: van.id });
    await apply({ kind: "phone.silence", deviceId: phone2.id, until: "2026-12-12T07:30:00Z" });
    await apply({ kind: "phone.force_active", deviceId: s.phone.id, until: "2026-12-12T07:30:00Z", intervalS: null });
    await apply({ kind: "phone.nudge", deviceId: s.phone.id });
    await apply({ kind: "phone.kill", deviceId: s.phone.id });
    await apply({ kind: "phone.revoke", deviceId: phone2.id });
    await apply({ kind: "phone.move_workspace", deviceId: phone3.id, toWorkspaceId: other.id });
    const code = (await apply({ kind: "pairing_code.create", label: "Bus 2" })) as { code: string; expiresAt: Date };
    expect(code.expiresAt.getTime()).toBe(NOW.getTime() + 10 * 60_000);
    await apply({
      kind: "notice.create",
      text: "The 10:20 is cancelled",
      severity: "heads_up",
      pinned: false,
      sort: 0,
      startsAt: null,
      endsAt: null,
      placements: ["everywhere"],
      channels: [],
    });
    await apply({ kind: "notice.end", noticeId: notice.id });
    const slug = `t-${randomUUID().slice(0, 8)}`;
    await apply({ kind: "workspace.create", slug, name: "Rehearsal" });

    const rows = await db()
      .select({ action: auditLog.action, proposalId: auditLog.proposalId, reason: auditLog.reason })
      .from(auditLog)
      .where(eq(auditLog.proposalId, "P-TESTTEST"))
      .orderBy(auditLog.id);
    expect(rows).toHaveLength(24);
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set([
        "spot.create",
        "spot.update",
        "spot.archive",
        "route.create",
        "route.update",
        "service.create",
        "service.update",
        "service.exception",
        "vehicle.create",
        "vehicle.update",
        "service_vehicle.assign",
        "service_vehicle.unassign",
        "phone.label",
        "phone.assign",
        "phone.silence",
        "phone.force_active",
        "phone.nudge",
        "phone.kill",
        "phone.revoke",
        "phone.move_workspace",
        "pairing_code.create",
        "notice.create",
        "notice.end",
        "workspace.create",
      ]),
    );
    expect(rows.every((r) => r.reason === "test")).toBe(true);
    const [ex] = await db()
      .select()
      .from(serviceExceptions)
      .where(and(eq(serviceExceptions.serviceId, s.service.id), eq(serviceExceptions.date, DAY)));
    expect(ex).toMatchObject({ kind: "cancel_departure", departure: "10:20" });
  });

  it("is refused by the service for a role that's too low", async () => {
    const s = await setup("ops");
    await expectCode(
      applyChange(db(), s.actor, s.ws.id, { kind: "phone.kill", deviceId: s.phone.id }, NOW),
      "FORBIDDEN",
    );
  });
});

describe("liveBoard", () => {
  it("lists every vehicle with its live state for a viewer", async () => {
    const s = await setup("viewer");
    const board = await liveBoard(db(), s.actor, { workspaceId: s.ws.id });
    expect(board).toEqual([{ vehicle: expect.objectContaining({ id: s.bus.id }), state: null }]);
  });

  it("never shows an off-duty vehicle's position (SPEC §4)", async () => {
    const s = await setup("viewer");
    const gf = { insideSpotId: null, candidateSpotId: null, enteredAt: null, outsideSince: null };
    await db()
      .insert(vehicleState)
      .values({
        vehicleId: s.bus.id,
        workspaceId: s.ws.id,
        phase: "off_duty",
        lat: 15.6,
        lng: 73.7,
        alongM: 5,
        geofence: gf as never,
      });
    const [{ state }] = await liveBoard(db(), s.actor, { workspaceId: s.ws.id });
    expect(state).toMatchObject({ phase: "off_duty", lat: null, lng: null, alongM: null, geofence: null });
  });

  it("FORBIDDEN outside the actor's workspace", async () => {
    const a = await setup("viewer");
    const b = await setup();
    await expectCode(liveBoard(db(), a.actor, { workspaceId: b.ws.id }), "FORBIDDEN");
  });
});

describe("actorFor", () => {
  it("builds the person's MCP admin actor for a workspace", async () => {
    const s = await setup("ops");
    const actor = await actorFor({ db: db(), personId: s.person.id, client: "claude.ai" })(s.ws.id);
    expect(actor).toMatchObject({
      kind: "admin",
      id: s.person.id,
      workspaceId: s.ws.id,
      role: "ops",
      channel: "mcp",
      client: "claude.ai",
    });
    const other = await makeWorkspace(db());
    await expectCode(actorFor({ db: db(), personId: s.person.id })(other.id), "FORBIDDEN");
  });
});

describe("OTA app updates", () => {
  const U1 = "01a13327-aaaa-bbbb-cccc-000000000001";
  const U2 = "02b24438-aaaa-bbbb-cccc-000000000002";

  it("versionKeys: the phone for ota.phone, nothing for workspace-wide ones", () => {
    const id = randomUUID();
    expect(versionKeys({ kind: "ota.rollout", updateId: U1 })).toEqual([]);
    expect(versionKeys({ kind: "ota.rollback" })).toEqual([]);
    expect(versionKeys({ kind: "ota.phone", deviceId: id, updateId: U1 })).toEqual([`device:${id}`]);
  });

  it("describes them in plain English", async () => {
    const { ws, phone } = await setup();
    await db().update(workspaces).set({ name: "Test" }).where(eq(workspaces.id, ws.id));
    const d = (c: McpChange) => describeChange(db(), ws.id, c);
    expect(await d({ kind: "ota.rollout", updateId: U1 })).toBe("Roll out app update 01a13327… to every phone in Test");
    expect(await d({ kind: "ota.rollout", updateId: null })).toBe(
      "Stop rolling out app updates in Test: phones keep the update they run",
    );
    expect(await d({ kind: "ota.rollback" })).toBe(
      "Roll every phone in Test back to the app update before the last rollout",
    );
    expect(await d({ kind: "ota.phone", deviceId: phone.id, updateId: U1 })).toBe(
      "Update phone 'Ravi's Redmi' (Bus 1) to app update 01a13327…",
    );
    expect(await d({ kind: "ota.phone", deviceId: phone.id, updateId: null })).toBe(
      "Put phone 'Ravi's Redmi' (Bus 1) back on Test's app update",
    );
  });

  it("warns that phones apply it only while idle, how many phones, and the native caveat", async () => {
    const { ws, phone } = await setup();
    await db()
      .insert(devices)
      .values([
        { workspaceId: ws.id, label: "Spare", tokenHash: randomUUID() },
        { workspaceId: ws.id, label: "Own", tokenHash: randomUUID(), targetUpdateId: U2 },
        { workspaceId: ws.id, label: "Gone", tokenHash: randomUUID(), revokedAt: NOW },
      ]);
    const [rollout] = await changeWarnings(db(), ws.id, [{ kind: "ota.rollout", updateId: U1 }], NOW);
    expect(rollout).toContain("only while idle");
    expect(rollout).toContain("2 phones in this workspace follow the workspace update (1 more has its own)");
    expect(rollout).toContain("needs new APK");
    const [back] = await changeWarnings(db(), ws.id, [{ kind: "ota.rollback" }], NOW);
    expect(back).toContain("2 phones in this workspace follow the workspace update");
    const [one] = await changeWarnings(db(), ws.id, [{ kind: "ota.phone", deviceId: phone.id, updateId: U1 }], NOW);
    expect(one).toContain("only while idle");
    expect(one).toContain("needs new APK");
    expect(await changeWarnings(db(), ws.id, [{ kind: "ota.rollout", updateId: null }], NOW)).toEqual([]);
  });

  it("applies through devices/ota, audited, and rolls back to the earlier target", async () => {
    const s = await setup("admin");
    const actor = { ...s.actor, proposalId: "P-OTAOTAOT", reason: "test" };
    const apply = (c: McpChange) => applyChange(db(), actor, s.ws.id, c, NOW);
    const target = async () =>
      (await db().select().from(workspaces).where(eq(workspaces.id, s.ws.id)))[0].targetUpdateId;
    await apply({ kind: "ota.rollout", updateId: U1 });
    await apply({ kind: "ota.rollout", updateId: U2 });
    expect(await target()).toBe(U2);
    await apply({ kind: "ota.rollback" });
    expect(await target()).toBe(U1);
    await apply({ kind: "ota.phone", deviceId: s.phone.id, updateId: U2 });
    const [p] = await db().select().from(devices).where(eq(devices.id, s.phone.id));
    expect(p.targetUpdateId).toBe(U2);
    const rows = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.proposalId, "P-OTAOTAOT"))
      .orderBy(auditLog.id);
    expect(rows.map((r) => r.action)).toEqual(["ota.rollout", "ota.rollout", "ota.rollback", "phone.update"]);
  });

  it("is admin only", async () => {
    const s = await setup("ops");
    await expectCode(applyChange(db(), s.actor, s.ws.id, { kind: "ota.rollout", updateId: U1 }, NOW), "FORBIDDEN");
  });
});
