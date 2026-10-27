import { istToEpoch } from "@eci-shuttle/shared";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { alertPrefs, auditLog, memberships, outbox } from "@/db/schema";
import { adminActor } from "@/services/auth/actor";
import { systemActor, type TelegramPayload } from "../kernel";
import { alertAdminChanges, muteAlert, raiseAlert, sendDigest } from "./alerts";

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
