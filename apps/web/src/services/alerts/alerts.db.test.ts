import { istToEpoch } from "@eci-shuttle/shared";
import { makeAssignedDevice, makeDevice } from "@tests/factories/alerts";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { alertPrefs, auditLog, deviceAssignments, memberships, outbox } from "@/db/schema";
import { adminActor } from "@/services/auth/actor";
import { systemActor, type TelegramPayload } from "../kernel";
import { alertAdminChanges, muteAlert, muteEntityFor, raiseAlert, sendDigest } from "./alerts";

// learning/insights is another task's module: fake its two reads
vi.mock("@/services/learning/insights", () => ({
  getInsights: vi.fn(async () => ({
    onTime: [
      { spotId: "a", pct: 90, n: 30 },
      { spotId: "b", pct: 60, n: 10 },
    ],
    trackedPct: 95,
  })),
  listSuggestions: vi.fn(async () => [{ summary: "Move the 09:40 from Riva to 09:45" }]),
}));

const db = () => testDb();
const NOW = new Date(istToEpoch("2026-10-12", "09:40"));

const jobs = async (workspaceId: string) =>
  (await db().select().from(outbox).where(eq(outbox.workspaceId, workspaceId))).map((j) => ({
    ...j,
    payload: j.payload as TelegramPayload,
  }));

describe("raiseAlert", () => {
  it("queues one telegram alert per opted-in member of that workspace only, deduped per key", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { person: a } = await makeAdmin(db(), ws.id); // defaults include silent
    const { person: optedOut } = await makeAdmin(db(), ws.id, "ops");
    await db()
      .insert(alertPrefs)
      .values({ personId: optedOut.id, workspaceId: ws.id, kinds: ["digest"] });
    const blocked = await makePerson(db(), { blockedBotAt: NOW });
    await db().insert(memberships).values({ personId: blocked.id, workspaceId: ws.id, role: "admin" });
    await makeAdmin(db(), other.id);

    const event = {
      workspaceId: ws.id,
      kind: "silent" as const,
      key: "silent:v1:1",
      html: "<b>Bus 1 has been silent</b>",
      buttons: [[{ text: "Open in admin", url: "http://x/admin/live" }]],
    };
    expect(await raiseAlert(db(), event, NOW)).toBe(1);
    expect(await raiseAlert(db(), event, NOW)).toBe(0);

    const [job] = await jobs(ws.id);
    expect(job).toMatchObject({ kind: "telegram", dedupeKey: `alert:silent:v1:1:${a.id}`, runAfter: NOW });
    expect(job.payload).toEqual({
      chatId: a.telegramId,
      html: event.html,
      kind: "alert",
      buttons: event.buttons,
      personId: a.id,
    });
    expect(await jobs(other.id)).toHaveLength(0);
  });

  it("holds the alert until quiet hours end", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id);
    await db()
      .insert(alertPrefs)
      .values({
        personId: person.id,
        workspaceId: ws.id,
        kinds: ["low_battery"],
        quietFrom: "09:00",
        quietTo: "10:00",
      });
    await raiseAlert(db(), { workspaceId: ws.id, kind: "low_battery", key: "lb:1", html: "x" }, NOW);
    const [job] = await jobs(ws.id);
    expect(job.runAfter).toEqual(new Date(istToEpoch("2026-10-12", "10:00")));
  });
});

describe("alertAdminChanges", () => {
  it("one alert per admin audit row to opted-in members, never the author, deduped per audit id", async () => {
    const ws = await makeWorkspace(db());
    const { person: author } = await makeAdmin(db(), ws.id);
    const { person: watcher } = await makeAdmin(db(), ws.id);
    const { person: notOptedIn } = await makeAdmin(db(), ws.id);
    for (const p of [author, watcher])
      await db()
        .insert(alertPrefs)
        .values({ personId: p.id, workspaceId: ws.id, kinds: ["admin_changes"] });
    const row = (at: Date, actorKind = "admin") => ({
      workspaceId: ws.id,
      actorKind,
      actorId: actorKind === "admin" ? author.id : "watchdog",
      actorLabel: "Naman",
      channel: "web",
      action: "spot.update",
      entity: "spot",
      entityId: "s1",
      at,
    });
    const [inside] = await db()
      .insert(auditLog)
      .values(row(new Date(NOW.getTime() - 60_000)))
      .returning();
    await db()
      .insert(auditLog)
      .values([row(new Date(NOW.getTime() - 300_000)), row(new Date(NOW.getTime() - 30_000), "system")]);

    const since = new Date(NOW.getTime() - 120_000);
    expect(await alertAdminChanges(db(), ws.id, since, NOW)).toBe(1);
    expect(await alertAdminChanges(db(), ws.id, since, NOW)).toBe(0);
    const all = await jobs(ws.id);
    expect(all).toHaveLength(1);
    expect(all[0].dedupeKey).toBe(`alert:admin:${inside.id}:${watcher.id}`);
    expect(all[0].payload.html).toContain("Naman");
    expect(all[0].payload.html).toContain("spot.update");
    expect(all[0].payload.html).toContain("09:39");
    expect(all.some((j) => j.payload.personId === notOptedIn.id)).toBe(false);
  });
});

describe("sendDigest", () => {
  it("sends yesterday's numbers and open suggestions to digest members once per IST day", async () => {
    const ws = await makeWorkspace(db());
    const { person } = await makeAdmin(db(), ws.id);
    expect(await sendDigest(db(), ws.id, NOW)).toBe(1);
    expect(await sendDigest(db(), ws.id, NOW)).toBe(0);
    const [job] = await jobs(ws.id);
    expect(job.dedupeKey).toBe(`alert:digest:${ws.id}:2026-10-12:${person.id}`);
    expect(job.payload.kind).toBe("digest");
    expect(job.payload.html).toContain("83%"); // (90×30 + 60×10) / 40
    expect(job.payload.html).toContain("95%");
    expect(job.payload.html).toContain("Move the 09:40 from Riva to 09:45");
    const { getInsights } = await import("@/services/learning/insights");
    expect(getInsights).toHaveBeenCalledWith(expect.anything(), systemActor("learning"), {
      workspaceId: ws.id,
      from: "2026-10-11",
      to: "2026-10-11",
    });
  });
});

describe("muteAlert", () => {
  const ev = (ws: string, deviceId: string, key: string, kind: "low_battery" | "silent" = "low_battery") => ({
    workspaceId: ws,
    kind,
    key,
    html: "<b>x</b>",
    mute: { kind: "low_battery" as const, deviceId },
  });

  it("snoozes that alert kind on that phone for the person for an hour; others and other kinds still alert", async () => {
    const ws = await makeWorkspace(db());
    const { person: a } = await makeAdmin(db(), ws.id);
    const { person: b } = await makeAdmin(db(), ws.id, "ops");
    const actor = await adminActor(db(), { personId: a.id, workspaceId: ws.id, channel: "telegram" });

    const r = await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: "d1", kind: "low_battery" }, NOW);
    expect(r.until.getTime()).toBe(NOW.getTime() + 3_600_000);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "alert.mute"), eq(auditLog.workspaceId, ws.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: ws.id, actorId: a.id, channel: "telegram", entity: "alert" });

    // only b is told; a muted this phone's battery alerts
    expect(await raiseAlert(db(), ev(ws.id, "d1", "low_battery:d1:1"), NOW)).toBe(1);
    const [job] = await jobs(ws.id);
    expect(job.dedupeKey).toBe(`alert:low_battery:d1:1:${b.id}`);
    // another phone is not muted
    expect(await raiseAlert(db(), ev(ws.id, "d2", "low_battery:d2:1"), NOW)).toBe(2);
    // after the hour a is told again
    const later = new Date(NOW.getTime() + 3_600_001);
    expect(await raiseAlert(db(), ev(ws.id, "d1", "low_battery:d1:2"), later)).toBe(2);
  });

  it("kind * (an old Silence 1h button) mutes every alert kind of that phone", async () => {
    const ws = await makeWorkspace(db());
    const { person: a } = await makeAdmin(db(), ws.id);
    const actor = await adminActor(db(), { personId: a.id, workspaceId: ws.id, channel: "telegram" });
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: "d1", kind: "*" }, NOW);
    const e = { ...ev(ws.id, "d1", "k1"), mute: { kind: "update_failed" as const, deviceId: "d1" } };
    expect(await raiseAlert(db(), e, NOW)).toBe(0);
  });

  it("is idempotent for a repeat press while muted (no second audit row)", async () => {
    const ws = await makeWorkspace(db());
    const { person: a } = await makeAdmin(db(), ws.id);
    const actor = await adminActor(db(), { personId: a.id, workspaceId: ws.id, channel: "telegram" });
    const input = { workspaceId: ws.id, deviceId: "d1", kind: "low_battery" as const };
    await muteAlert(db(), actor, input, NOW);
    const again = await muteAlert(db(), actor, input, new Date(NOW.getTime() + 60_000));
    expect(again.already).toBe(true);
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "alert.mute"), eq(auditLog.workspaceId, ws.id))),
    ).toHaveLength(1);
  });
});

describe("muteAlert: vehicle problems follow the vehicle", () => {
  // a vehicle with two phones: the problem can be attributed to either
  async function setup() {
    const ws = await makeWorkspace(db());
    const { person: a } = await makeAdmin(db(), ws.id);
    const { person: b } = await makeAdmin(db(), ws.id, "ops");
    const actor = await adminActor(db(), { personId: a.id, workspaceId: ws.id, channel: "telegram" });
    const { vehicle, device: phone1 } = await makeAssignedDevice(db(), ws.id);
    const phone2 = await makeDevice(db(), ws.id, { label: "Backup" });
    await db().insert(deviceAssignments).values({ workspaceId: ws.id, deviceId: phone2.id, vehicleId: vehicle.id });
    const event = (kind: "silent" | "low_battery", deviceId: string, key: string) => ({
      workspaceId: ws.id,
      kind,
      key,
      html: "<b>x</b>",
      mute: { kind, deviceId, vehicleId: vehicle.id },
    });
    return { ws, a, b, actor, vehicle, phone1, phone2, event };
  }

  it("a silent mute pressed via one phone also covers the alert attributed to the vehicle's other phone", async () => {
    const { ws, b, actor, phone1, phone2, event } = await setup();
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: phone1.id, kind: "silent" }, NOW);
    expect(await raiseAlert(db(), event("silent", phone2.id, "silent:v:1"), NOW)).toBe(1);
    const [job] = await jobs(ws.id);
    expect(job.dedupeKey).toBe(`alert:silent:v:1:${b.id}`);
  });

  it("a mute of a vehicle problem does not mute that vehicle's phone problems, nor another vehicle", async () => {
    const { ws, actor, phone1, phone2, event } = await setup();
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: phone1.id, kind: "silent" }, NOW);
    expect(await raiseAlert(db(), event("low_battery", phone2.id, "low_battery:p2:1"), NOW)).toBe(2);
    const other = await makeAssignedDevice(db(), ws.id, { vehicle: { name: "Bus 2" } });
    const e = {
      ...event("silent", other.device.id, "silent:v2:1"),
      mute: { kind: "silent", deviceId: other.device.id, vehicleId: other.vehicle.id },
    };
    expect(await raiseAlert(db(), e, NOW)).toBe(2);
  });

  it("phone problems stay per device: a low_battery mute on one phone leaves the vehicle's other phone alerting", async () => {
    const { ws, actor, phone1, phone2, event } = await setup();
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: phone1.id, kind: "low_battery" }, NOW);
    expect(await raiseAlert(db(), event("low_battery", phone2.id, "low_battery:p2:1"), NOW)).toBe(2);
    expect(await raiseAlert(db(), event("low_battery", phone1.id, "low_battery:p1:1"), NOW)).toBe(1);
  });

  it("muteEntityFor: one entity for both phones of a vehicle (vehicle kinds), one per phone otherwise", async () => {
    const { ws, phone1, phone2 } = await setup();
    const e = (d: string, k: string) => muteEntityFor(db(), ws.id, d, k);
    expect(await e(phone1.id, "silent")).toBe(await e(phone2.id, "silent"));
    expect(await e(phone1.id, "low_battery")).not.toBe(await e(phone2.id, "low_battery"));
    expect(await e("d1", "silent")).toBe("silent:d1");
  });

  it("a repeat press via the vehicle's other phone is already muted (one audit row); expires after the hour", async () => {
    const { ws, actor, phone1, phone2, event } = await setup();
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: phone1.id, kind: "silent" }, NOW);
    const again = await muteAlert(
      db(),
      actor,
      { workspaceId: ws.id, deviceId: phone2.id, kind: "silent" },
      new Date(NOW.getTime() + 60_000),
    );
    expect(again.already).toBe(true);
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "alert.mute"), eq(auditLog.workspaceId, ws.id))),
    ).toHaveLength(1);
    const later = new Date(NOW.getTime() + 3_600_001);
    expect(await raiseAlert(db(), event("silent", phone2.id, "silent:v:2"), later)).toBe(2);
  });

  it("a mute row written by an old button (keyed to the device) still applies, and a phone with no vehicle mutes per device", async () => {
    const { ws, actor, phone1, event } = await setup();
    const loose = await makeDevice(db(), ws.id, { label: "Loose" });
    await muteAlert(db(), actor, { workspaceId: ws.id, deviceId: loose.id, kind: "silent" }, NOW);
    const e = {
      workspaceId: ws.id,
      kind: "silent" as const,
      key: "silent:loose",
      html: "x",
      mute: { kind: "silent", deviceId: loose.id },
    };
    expect(await raiseAlert(db(), e, NOW)).toBe(1);
    // old-style row: entityId `<kind>:<deviceId>` written by an earlier release
    await db()
      .insert(auditLog)
      .values({
        workspaceId: ws.id,
        actorKind: actor.kind,
        actorId: actor.id,
        channel: "telegram",
        action: "alert.mute",
        entity: "alert",
        entityId: `silent:${phone1.id}`,
        before: null,
        after: { kind: "silent", deviceId: phone1.id, until: new Date(NOW.getTime() + 600_000).toISOString() },
      } as never);
    expect(await raiseAlert(db(), event("silent", phone1.id, "silent:v:3"), NOW)).toBe(1);
  });
});
