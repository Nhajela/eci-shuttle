import { randomUUID } from "node:crypto";
import { type Role, resolveMode } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import {
  alertPrefs,
  auditLog,
  deviceAssignments,
  devices,
  directives,
  memberships,
  outbox,
  vehicles,
} from "@/db/schema";
import { SILENT_AFTER_MS } from "../alerts/watchdog";
import { enqueue } from "../kernel";
import { bumpConfigs, desiredConfig } from "./config";
import {
  assignPhone,
  cancelDirective,
  forceActive,
  getPhone,
  getVehiclePhone,
  killPhone,
  labelPhone,
  listPhones,
  movePhoneToWorkspace,
  nudgePhone,
  revokePhone,
  silencePhone,
  trackedDevices,
} from "./phones";

// config.ts belongs to another task: stand in for its contract (bump non-revoked devices + one push each).
vi.mock("./config", () => ({
  bumpConfigs: vi.fn(async (db: Db, t: { deviceIds?: string[] }, reason: string) => {
    const ids = t.deviceIds ?? [];
    if (!ids.length) return [];
    const { sql } = await import("drizzle-orm");
    const rows = await db
      .update(devices)
      .set({ configVersion: sql`${devices.configVersion} + 1` })
      .where(and(inArray(devices.id, ids), isNull(devices.revokedAt)))
      .returning();
    for (const d of rows)
      await enqueue(db, {
        kind: "push",
        payload: { deviceId: d.id, reason },
        workspaceId: d.workspaceId,
        dedupeKey: `push:${d.id}:${d.configVersion}`,
      });
    return rows.map((d) => d.id);
  }),
  desiredConfig: vi.fn(async () => ({ configVersion: 1, killed: false, revoked: false, schedule: [] })),
}));
vi.mock("@eci-shuttle/shared", async (orig) => ({
  ...(await orig<typeof import("@eci-shuttle/shared")>()),
  resolveMode: vi.fn((c: { killed: boolean }) => ({ mode: c.killed ? "killed" : "idle" })),
}));

const db = () => testDb();
const HOUR = 3_600_000;
const later = (ms = HOUR) => new Date(Date.now() + ms).toISOString();

async function setup(role: Role = "admin", over: Partial<typeof devices.$inferInsert> = {}) {
  const ws = await makeWorkspace(db());
  const { actor, person } = await makeAdmin(db(), ws.id, role);
  const phone = await makeDevice(ws.id, over);
  return { ws, actor, person, phone };
}
async function makeDevice(workspaceId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [d] = await db()
    .insert(devices)
    .values({ workspaceId, label: "Phone", tokenHash: randomUUID(), ...over })
    .returning();
  return d;
}
async function makeVehicle(workspaceId: string, name = "Bus 1") {
  const [v] = await db().insert(vehicles).values({ workspaceId, name }).returning();
  return v;
}
const device = async (id: string) => (await db().select().from(devices).where(eq(devices.id, id)))[0];
const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId));
const pushes = (deviceId: string) =>
  db()
    .select()
    .from(outbox)
    .then((rows) => rows.filter((r) => (r.payload as { deviceId?: string }).deviceId === deviceId));
const openAssignments = (deviceId: string) =>
  db()
    .select()
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endsAt)));

beforeEach(() => {
  vi.mocked(bumpConfigs).mockClear();
});

describe("labelPhone", () => {
  it("renames the phone, bumps version, audits phone.label; ops may do it", async () => {
    const { ws, actor, phone } = await setup("ops");
    const d = await labelPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, label: "  Raju's phone " });
    expect(d.label).toBe("Raju's phone");
    expect(d.version).toBe(phone.version + 1);
    const [a] = await audits(phone.id);
    expect(a).toMatchObject({ action: "phone.label", entity: "device", workspaceId: ws.id });
    expect(a.after).toEqual({ label: "Raju's phone", version: 2 });
  });

  it("viewers can't; another workspace's phone is NOT_FOUND; bad input is INVALID", async () => {
    const { ws, phone } = await setup();
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");
    await expect(
      labelPhone(db(), viewer, { workspaceId: ws.id, deviceId: phone.id, label: "x" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const other = await setup();
    await expect(
      labelPhone(db(), other.actor, { workspaceId: other.ws.id, deviceId: phone.id, label: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      labelPhone(db(), other.actor, { workspaceId: other.ws.id, deviceId: phone.id, label: "" }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("assignPhone", () => {
  it("opens a time-bound assignment, and reassigning closes the old row", async () => {
    const { ws, actor, phone } = await setup("ops");
    const v1 = await makeVehicle(ws.id);
    const v2 = await makeVehicle(ws.id, "Bus 2");
    const a1 = await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v1.id });
    expect(a1).toMatchObject({ deviceId: phone.id, vehicleId: v1.id, endsAt: null });
    const a2 = await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v2.id });
    expect(a2?.vehicleId).toBe(v2.id);
    const rows = await db().select().from(deviceAssignments).where(eq(deviceAssignments.deviceId, phone.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a1?.id)?.endsAt).toBeInstanceOf(Date);
    expect(await openAssignments(phone.id)).toHaveLength(1);
    expect((await device(phone.id)).configVersion).toBe(3);
    const log = await audits(phone.id);
    expect(log.map((l) => l.action)).toEqual(["phone.assign", "phone.assign"]);
    expect(log[1].before).toEqual({ vehicleId: v1.id });
    expect(log[1].after).toEqual({ vehicleId: v2.id });
  });

  it("takes the vehicle from the phone that held it and bumps both phones", async () => {
    const { ws, actor, phone } = await setup();
    const other = await makeDevice(ws.id);
    const v = await makeVehicle(ws.id);
    await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: other.id, vehicleId: v.id });
    vi.mocked(bumpConfigs).mockClear();
    await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    expect(await openAssignments(other.id)).toHaveLength(0);
    expect(await openAssignments(phone.id)).toHaveLength(1);
    expect(vi.mocked(bumpConfigs).mock.calls[0][1].deviceIds?.sort()).toEqual([phone.id, other.id].sort());
    expect(await pushes(other.id)).toHaveLength(2);
  });

  it("null unassigns; assigning the same vehicle again writes nothing", async () => {
    const { ws, actor, phone } = await setup();
    const v = await makeVehicle(ws.id);
    const a = await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    expect(await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id })).toEqual(a);
    expect(await audits(phone.id)).toHaveLength(1);
    expect(await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: null })).toBeNull();
    expect(await openAssignments(phone.id)).toHaveLength(0);
    expect(await audits(phone.id)).toHaveLength(2);
  });

  it("refuses another workspace's vehicle and a revoked phone", async () => {
    const { ws, actor, phone } = await setup();
    const foreign = await makeVehicle((await makeWorkspace(db())).id);
    await expect(
      assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: foreign.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const revoked = await makeDevice(ws.id, { revokedAt: new Date() });
    const v = await makeVehicle(ws.id);
    await expect(
      assignPhone(db(), actor, { workspaceId: ws.id, deviceId: revoked.id, vehicleId: v.id }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("directives", () => {
  it("silence makes a silence_until [now, until) on the phone and bumps its config", async () => {
    const { ws, actor, phone } = await setup("ops");
    const until = later(2 * HOUR);
    const d = await silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until });
    expect(d).toMatchObject({ kind: "silence_until", deviceId: phone.id, vehicleId: null, intervalS: null });
    expect(d.endsAt.toISOString()).toBe(until);
    expect(d.startsAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await device(phone.id)).configVersion).toBe(2);
    expect((await audits(d.id))[0]).toMatchObject({ action: "phone.silence", entity: "directive" });
  });

  it("force active carries intervalS", async () => {
    const { ws, actor, phone } = await setup("ops");
    const d = await forceActive(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later(), intervalS: 5 });
    expect(d).toMatchObject({ kind: "force_active", intervalS: 5 });
    const d2 = await forceActive(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later() });
    expect(d2.intervalS).toBeNull();
    expect((await audits(d.id))[0].action).toBe("phone.force_active");
  });

  it("force active cancels the phone's open silence, and silence cancels an open force", async () => {
    const { ws, actor, phone } = await setup("ops");
    const s = await silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later() });
    const f = await forceActive(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later(2 * HOUR) });
    const row = async (id: string) => (await db().select().from(directives).where(eq(directives.id, id)))[0];
    expect((await row(s.id)).cancelledAt).toBeInstanceOf(Date);
    expect((await audits(f.id))[0].after).toMatchObject({ cancelledDirectiveIds: [s.id] });
    const s2 = await silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later() });
    expect((await row(f.id)).cancelledAt).toBeInstanceOf(Date);
    expect((await row(s2.id)).cancelledAt).toBeNull();
  });

  it("force active on a phone whose vehicle is silenced is INVALID", async () => {
    const { ws, actor, phone } = await setup("ops");
    const v = await makeVehicle(ws.id);
    await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    await db()
      .insert(directives)
      .values({ workspaceId: ws.id, vehicleId: v.id, kind: "silence_until", endsAt: new Date(Date.now() + HOUR) });
    await expect(
      forceActive(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later(2 * HOUR) }),
    ).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/silenced until \d\d:\d\d IST/) });
  });

  it("refuses an until in the past, and a viewer", async () => {
    const { ws, actor, phone } = await setup();
    await expect(
      silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later(-HOUR) }),
    ).rejects.toMatchObject({ code: "INVALID" });
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");
    await expect(
      forceActive(db(), viewer, { workspaceId: ws.id, deviceId: phone.id, until: later() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cancelDirective ends it early and bumps the phone; cancelling again is a no-op", async () => {
    const { ws, actor, phone } = await setup("ops");
    const d = await silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later() });
    await cancelDirective(db(), actor, { workspaceId: ws.id, directiveId: d.id });
    const [row] = await db().select().from(directives).where(eq(directives.id, d.id));
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect((await device(phone.id)).configVersion).toBe(3);
    await cancelDirective(db(), actor, { workspaceId: ws.id, directiveId: d.id });
    expect((await audits(d.id)).map((a) => a.action)).toEqual(["phone.silence", "directive.cancel"]);
  });

  it("cancelling a vehicle directive bumps that vehicle's phones", async () => {
    const { ws, actor } = await setup();
    const v = await makeVehicle(ws.id);
    const [d] = await db()
      .insert(directives)
      .values({ workspaceId: ws.id, vehicleId: v.id, kind: "active_window", endsAt: new Date(Date.now() + HOUR) })
      .returning();
    await cancelDirective(db(), actor, { workspaceId: ws.id, directiveId: d.id });
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ vehicleIds: [v.id] });
  });
});

describe("nudgePhone", () => {
  it("queues a push without changing config, audited phone.nudge", async () => {
    const { ws, actor, phone } = await setup("ops");
    await nudgePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id });
    expect((await device(phone.id)).configVersion).toBe(1);
    const [p] = await pushes(phone.id);
    expect(p).toMatchObject({ kind: "push", workspaceId: ws.id, payload: { deviceId: phone.id, reason: "nudge" } });
    expect((await audits(phone.id))[0]).toMatchObject({ action: "phone.nudge", entity: "device" });
  });
});

describe("kill / revoke", () => {
  it("kill is admin only, sets killed_at, bumps config; killing again is a no-op", async () => {
    const { ws, actor, phone } = await setup();
    const { actor: ops } = await makeAdmin(db(), ws.id, "ops");
    await expect(killPhone(db(), ops, { workspaceId: ws.id, deviceId: phone.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const d = await killPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id });
    expect(d.killedAt).toBeInstanceOf(Date);
    expect(d.configVersion).toBe(2);
    expect(await pushes(phone.id)).toHaveLength(1);
    expect((await killPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id })).killedAt).toEqual(d.killedAt);
    expect((await audits(phone.id)).map((a) => a.action)).toEqual(["phone.kill"]);
  });

  it("kill raises the kill_resume alert to members who want it, once", async () => {
    const { ws, actor, person, phone } = await setup();
    const { person: optedOut } = await makeAdmin(db(), ws.id);
    await db()
      .insert(alertPrefs)
      .values({ personId: optedOut.id, workspaceId: ws.id, kinds: ["low_battery"] });
    await killPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id });
    await killPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id });
    const alerts = await db()
      .select()
      .from(outbox)
      .where(and(eq(outbox.workspaceId, ws.id), eq(outbox.kind, "telegram")));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toMatchObject({ kind: "alert", personId: person.id });
    expect((alerts[0].payload as { html: string }).html).toContain("Phone 'Phone' killed");
  });

  it("revoke sets revoked_at, closes the assignment, and still pushes so the phone learns it", async () => {
    const { ws, actor, phone } = await setup();
    const v = await makeVehicle(ws.id);
    await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    const d = await revokePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id });
    expect(d.revokedAt).toBeInstanceOf(Date);
    expect(d.configVersion).toBe(3);
    expect(await openAssignments(phone.id)).toHaveLength(0);
    expect(await pushes(phone.id)).toHaveLength(2);
    expect((await audits(phone.id)).at(-1)?.action).toBe("phone.revoke");
  });
});

describe("movePhoneToWorkspace", () => {
  async function twoWorkspaces(targetRole: Role | null = "admin", over: Partial<typeof devices.$inferInsert> = {}) {
    const s = await setup("admin", over);
    const to = await makeWorkspace(db());
    if (targetRole)
      await db().insert(memberships).values({ personId: s.person.id, workspaceId: to.id, role: targetRole });
    return { ...s, to };
  }

  it("moves the device only, clears assignments and directives, bumps config", async () => {
    const { ws, actor, phone, to } = await twoWorkspaces("admin", { targetUpdateId: "test-update-1" });
    const v = await makeVehicle(ws.id);
    await assignPhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    const dir = await silencePhone(db(), actor, { workspaceId: ws.id, deviceId: phone.id, until: later() });
    const d = await movePhoneToWorkspace(db(), actor, { workspaceId: ws.id, deviceId: phone.id, toWorkspaceId: to.id });
    expect(d.workspaceId).toBe(to.id);
    expect(d.targetUpdateId).toBeNull(); // the new workspace's OTA target applies
    expect(d.configVersion).toBe(4);
    expect(await openAssignments(phone.id)).toHaveLength(0);
    const [dirRow] = await db().select().from(directives).where(eq(directives.id, dir.id));
    expect(dirRow.cancelledAt).toBeInstanceOf(Date);
    expect((await db().select().from(vehicles).where(eq(vehicles.id, v.id)))[0].workspaceId).toBe(ws.id);
    const [a] = (await audits(phone.id)).filter((x) => x.action === "phone.move_workspace");
    expect(a.after).toMatchObject({ workspaceId: to.id, targetUpdateId: null });
    expect(a.before).toMatchObject({ targetUpdateId: "test-update-1" });
  });

  it("needs admin in the target workspace too", async () => {
    for (const role of [null, "ops"] as const) {
      const { ws, actor, phone, to } = await twoWorkspaces(role);
      await expect(
        movePhoneToWorkspace(db(), actor, { workspaceId: ws.id, deviceId: phone.id, toWorkspaceId: to.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("a simulated phone can't move into the live workspace; same workspace is INVALID", async () => {
    const { ws, actor, phone, person } = await twoWorkspaces(null, { simulated: true });
    const live = await makeWorkspace(db(), { isLive: true }).catch(async () => {
      // another test file may hold the one live workspace: borrow it
      const { workspaces } = await import("@/db/schema");
      return (await db().select().from(workspaces).where(eq(workspaces.isLive, true)))[0];
    });
    await db().insert(memberships).values({ personId: person.id, workspaceId: live.id, role: "admin" });
    await expect(
      movePhoneToWorkspace(db(), actor, { workspaceId: ws.id, deviceId: phone.id, toWorkspaceId: live.id }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      movePhoneToWorkspace(db(), actor, { workspaceId: ws.id, deviceId: phone.id, toWorkspaceId: ws.id }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("listPhones", () => {
  it("reports health per phone, revoked last", async () => {
    const ws = await makeWorkspace(db(), { minAppVersion: "1.4.0" });
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const now = new Date();
    const v = await makeVehicle(ws.id);
    const gone = await makeDevice(ws.id, { label: "A gone", revokedAt: now });
    const ok = await makeDevice(ws.id, {
      label: "B ok",
      appVersion: "1.10.0",
      reportedMode: "idle",
      reportedConfigVersion: 1,
      lastSyncAt: new Date(now.getTime() - 30_000),
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
    });
    const bad = await makeDevice(ws.id, {
      label: "C bad",
      appVersion: "1.3.9",
      reportedMode: "active",
      killedAt: now,
      updateFailedAt: now,
      permissions: {
        location: "foreground",
        preciseLocation: true,
        notifications: true,
        batteryOptimizationExempt: true,
      },
    });
    await db().insert(deviceAssignments).values({ workspaceId: ws.id, deviceId: ok.id, vehicleId: v.id });
    await db()
      .insert(directives)
      .values([
        { workspaceId: ws.id, vehicleId: v.id, kind: "active_window", endsAt: new Date(now.getTime() + HOUR) },
        { workspaceId: ws.id, deviceId: ok.id, kind: "silence_until", endsAt: new Date(now.getTime() - 1) },
      ]);
    vi.mocked(desiredConfig).mockImplementation(async (_db, id) => ({ killed: id === bad.id }) as never);

    const list = await listPhones(db(), actor, { workspaceId: ws.id }, now);
    expect(list.map((p) => p.device.label)).toEqual(["B ok", "C bad", "A gone"]);
    const [b, c, a] = list;
    expect(b).toMatchObject({
      vehicle: { id: v.id },
      desiredMode: "idle",
      modeMismatch: false,
      configBehind: false,
      lastSyncAgoS: 30,
      needsNewApk: false,
      updateFailed: false,
      permissionsOk: true,
    });
    expect(b.activeDirectives.map((d) => d.kind)).toEqual(["active_window"]);
    expect(c).toMatchObject({
      vehicle: null,
      desiredMode: "killed",
      modeMismatch: false, // kill pending: it hasn't synced since
      configBehind: true,
      lastSyncAgoS: null,
      needsNewApk: true,
      updateFailed: true,
      permissionsOk: false,
    });
    expect(a.desiredMode).toBe("revoked");
    expect(gone.id).toBe(a.device.id);
  });

  it("needs viewer in the workspace", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), (await makeWorkspace(db())).id, "admin");
    await expect(listPhones(db(), actor, { workspaceId: ws.id }, new Date())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("silent: assigned, should be active, last sync (or window start) over SILENT_AFTER_MS ago", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const quiet = await makeDevice(ws.id, { label: "A", lastSyncAt: ago(SILENT_AFTER_MS + 1000) });
    const fresh = await makeDevice(ws.id, { label: "B", lastSyncAt: ago(SILENT_AFTER_MS - 1000) });
    const never = await makeDevice(ws.id, { label: "C" }); // its window opened a minute ago: not silent yet
    await makeDevice(ws.id, { label: "D", lastSyncAt: ago(HOUR) }); // no vehicle
    for (const d of [quiet, fresh, never])
      await db()
        .insert(deviceAssignments)
        .values({ workspaceId: ws.id, deviceId: d.id, vehicleId: (await makeVehicle(ws.id, d.label)).id });
    vi.mocked(desiredConfig).mockImplementation(
      async (_db, id) => ({ start: now.getTime() - (id === never.id ? 60_000 : HOUR) }) as never,
    );
    vi.mocked(resolveMode).mockImplementation(
      (c) => ({ mode: "active", window: { startsAt: (c as unknown as { start: number }).start } }) as never,
    );
    try {
      const list = await listPhones(db(), actor, { workspaceId: ws.id }, now);
      expect(Object.fromEntries(list.map((p) => [p.device.label, p.silent]))).toEqual({
        A: true,
        B: false,
        C: false,
        D: false,
      });
    } finally {
      vi.mocked(resolveMode).mockImplementation(
        (c) => ({ mode: (c as unknown as { killed: boolean }).killed ? "killed" : "idle" }) as never,
      );
    }
  });
});

describe("listPhones modeMismatch (the watchdog's rule)", () => {
  const MIN = 60_000;
  async function mismatchOf(over: Partial<typeof devices.$inferInsert>, pushedAgoMs: number | null, intervalS = 10) {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const now = new Date();
    const d = await makeDevice(ws.id, {
      reportedMode: "active", // told idle (resolveMode mock)
      configVersion: 2,
      reportedConfigVersion: 2,
      lastSyncAt: now,
      ...over,
    });
    if (pushedAgoMs !== null)
      await db()
        .insert(outbox)
        .values({
          workspaceId: ws.id,
          kind: "push",
          payload: { deviceId: d.id },
          dedupeKey: `push:${d.id}:${d.configVersion}`,
          createdAt: new Date(now.getTime() - pushedAgoMs),
        });
    vi.mocked(desiredConfig).mockImplementationOnce(
      async () => ({ killed: !!over.killedAt, schedule: [], activeIntervalS: intervalS, idleHeartbeatS: 900 }) as never,
    );
    return (await listPhones(db(), actor, { workspaceId: ws.id }, now))[0].modeMismatch;
  }

  it("flags a phone on its current config, reporting the wrong mode past the grace", async () => {
    expect(await mismatchOf({}, 5 * MIN)).toBe(true);
  });
  it("not within two sync intervals (at least 2 min) of the config change", async () => {
    expect(await mismatchOf({}, 1 * MIN)).toBe(false);
    expect(await mismatchOf({}, 5 * MIN, 300)).toBe(false); // 2 x 5 min interval
  });
  it("not before the phone has applied the current config", async () => {
    expect(await mismatchOf({ reportedConfigVersion: 1 }, 5 * MIN)).toBe(false);
  });
  it("not when it reports what it should", async () => {
    expect(await mismatchOf({ reportedMode: "idle" }, 5 * MIN)).toBe(false);
  });
  it("killed: only once it synced after the kill on its config and still reports active", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms);
    expect(await mismatchOf({ killedAt: ago(MIN), lastSyncAt: ago(5 * MIN) }, null)).toBe(false);
    expect(await mismatchOf({ killedAt: ago(5 * MIN), lastSyncAt: ago(MIN), reportedConfigVersion: 1 }, null)).toBe(
      false,
    );
    expect(await mismatchOf({ killedAt: ago(5 * MIN), lastSyncAt: ago(MIN) }, null)).toBe(true);
  });
});

describe("getPhone / getVehiclePhone", () => {
  it("getPhone reads one phone's health by id; another workspace's phone is NOT_FOUND", async () => {
    const { ws, phone } = await setup();
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const v = await makeVehicle(ws.id);
    await db().insert(deviceAssignments).values({ workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    const h = await getPhone(db(), actor, { deviceId: phone.id }, new Date());
    expect(h).toMatchObject({ device: { id: phone.id }, vehicle: { id: v.id }, desiredMode: "idle", silent: false });
    const other = await setup();
    await expect(getPhone(db(), other.actor, { deviceId: phone.id }, new Date())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getPhone(db(), actor, { deviceId: randomUUID() }, new Date())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("getVehiclePhone is the vehicle's current phone, or null", async () => {
    const { ws, actor, phone } = await setup("viewer");
    const v = await makeVehicle(ws.id);
    const empty = await makeVehicle(ws.id, "Bus 2");
    await db().insert(deviceAssignments).values({ workspaceId: ws.id, deviceId: phone.id, vehicleId: v.id });
    const input = { workspaceId: ws.id };
    expect((await getVehiclePhone(db(), actor, { ...input, vehicleId: v.id }, new Date()))?.device.id).toBe(phone.id);
    expect(await getVehiclePhone(db(), actor, { ...input, vehicleId: empty.id }, new Date())).toBeNull();
    const foreign = await makeVehicle((await makeWorkspace(db())).id);
    await expect(getVehiclePhone(db(), actor, { ...input, vehicleId: foreign.id }, new Date())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("trackedDevices", () => {
  it("lists the workspace's assigned phones that are not revoked", async () => {
    const ws = await makeWorkspace(db());
    const v1 = await makeVehicle(ws.id);
    const v2 = await makeVehicle(ws.id, "Bus 2");
    const a = await makeDevice(ws.id);
    await makeDevice(ws.id); // unassigned
    const gone = await makeDevice(ws.id, { revokedAt: new Date() });
    await db()
      .insert(deviceAssignments)
      .values([
        { workspaceId: ws.id, deviceId: a.id, vehicleId: v1.id },
        { workspaceId: ws.id, deviceId: gone.id, vehicleId: v2.id },
      ]);
    const other = await makeWorkspace(db());
    const od = await makeDevice(other.id);
    const ov = await makeVehicle(other.id);
    await db().insert(deviceAssignments).values({ workspaceId: other.id, deviceId: od.id, vehicleId: ov.id });
    expect(await trackedDevices(db(), ws.id)).toEqual([{ deviceId: a.id, vehicleId: v1.id }]);
  });
});
