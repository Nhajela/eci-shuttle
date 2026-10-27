import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, deviceAssignments, devices, vehicles } from "@/db/schema";
import type { Person } from "@/db/types";
import { createPairingCode } from "../devices/pairing";
import { syncDevice } from "../devices/sync";
import { onLocation, onPair, TELEGRAM_MODEL } from "./live";
import type { BotContext, TgMessage } from "./types";

vi.mock("../devices/sync", async (orig) => ({
  ...(await orig<typeof import("../devices/sync")>()),
  syncDevice: vi.fn(async () => ({})),
}));

const db = () => testDb();
const NOW = new Date("2026-10-12T04:30:00Z");
const SEC = Math.floor(NOW.getTime() / 1000);

const ctxFor = async (person: Person): Promise<BotContext> => ({
  db: db(),
  now: NOW,
  person,
  chatId: person.telegramId,
  workspace: await makeWorkspace(db()),
});
const codeIn = async (workspaceId: string, label?: string) => {
  const { actor } = await makeAdmin(db(), workspaceId);
  return (await createPairingCode(db(), actor, { workspaceId, label }, NOW)).code;
};
const html = (r: { send: { html: string }[] }) => r.send.map((s) => s.html).join("\n");

const locMsg = (telegramId: number, over: Partial<TgMessage> = {}, loc: Partial<TgMessage["location"]> = {}) =>
  ({
    message_id: 5,
    date: SEC - 60,
    chat: { id: telegramId, type: "private" },
    from: { id: telegramId, first_name: "Ravi" },
    location: { latitude: 15.67, longitude: 73.71, live_period: 28800, ...loc },
    ...over,
  }) as TgMessage;

beforeEach(async () => {
  vi.mocked(syncDevice).mockClear();
  // pairing's wrong-code cap counts every miss in the DB for 10 min; other files on this worker make misses on purpose
  await db().delete(auditLog).where(eq(auditLog.action, "device.pair_failed"));
});

describe("onPair (/pair 123456)", () => {
  it("pairs a Telegram live-location device in the code's workspace, linked to the sender, with instructions", async () => {
    const person = await makePerson(db(), { firstName: "Ravi" });
    const ctx = await ctxFor(person);
    const ws = await makeWorkspace(db());
    const reply = await onPair(ctx, await codeIn(ws.id));
    expect(html(reply)).toMatch(/Share My Live Location/);
    expect(html(reply)).toMatch(/until I turn it off/);
    expect(html(reply)).toMatch(/isn't on a shuttle yet/);
    const [d] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    expect(d).toMatchObject({ workspaceId: ws.id, model: TELEGRAM_MODEL, appVersion: "telegram", label: "Ravi" });
  });

  it("keeps the code's label, and a second pair moves the link to the new device", async () => {
    const person = await makePerson(db());
    const ctx = await ctxFor(person);
    const ws = await makeWorkspace(db());
    await onPair(ctx, await codeIn(ws.id));
    await onPair(ctx, await codeIn(ws.id, "Bus 2"));
    const rows = await db().select().from(devices).where(eq(devices.workspaceId, ws.id));
    expect(rows).toHaveLength(2);
    const linked = rows.filter((r) => r.tokenHash === `telegram:${person.telegramId}`);
    expect(linked).toHaveLength(1);
    expect(linked[0].label).toBe("Bus 2");
  });

  it("asks for the code when missing and explains a bad one", async () => {
    const ctx = await ctxFor(await makePerson(db()));
    expect(html(await onPair(ctx, null))).toMatch(/\/pair 123456/);
    await expect(onPair(ctx, "999999x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

const assign = async (d: { id: string; workspaceId: string }) => {
  const [v] = await db().insert(vehicles).values({ workspaceId: d.workspaceId, name: "Bus 1" }).returning();
  await db().insert(deviceAssignments).values({ workspaceId: d.workspaceId, deviceId: d.id, vehicleId: v.id });
  return v;
};
const unassign = (deviceId: string, at: Date) =>
  db().update(deviceAssignments).set({ endsAt: at }).where(eq(deviceAssignments.deviceId, deviceId));
const notices = (deviceId: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, deviceId), eq(auditLog.action, "device.driver_notified")));

describe("onLocation", () => {
  const paired = async (assigned = true) => {
    const person = await makePerson(db());
    const ws = await makeWorkspace(db());
    await onPair(await ctxFor(person), await codeIn(ws.id));
    const [d] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    if (assigned) await assign(d);
    return { person, device: d };
  };

  it("maps the first live location to a ping and syncs the linked device as an always-on phone", async () => {
    const { person, device } = await paired();
    const reply = await onLocation(db(), locMsg(person.telegramId, {}, { horizontal_accuracy: 12, heading: 90 }), NOW);
    expect(html(reply)).toMatch(/live location/i);
    const [actor, input, now] = vi.mocked(syncDevice).mock.calls[0].slice(1);
    expect(actor).toMatchObject({ kind: "device", id: device.id, workspaceId: device.workspaceId });
    expect(now).toBe(NOW);
    expect(input).toMatchObject({
      pings: [
        {
          recordedAt: (SEC - 60) * 1000,
          lat: 15.67,
          lng: 73.71,
          accuracy: 12,
          speed: null,
          heading: 90,
          battery: null,
        },
      ],
      permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
      reportedMode: "active",
      appVersion: "telegram",
      appliedConfigVersion: 2_147_483_647,
    });
  });

  it("an edited_message update uses edit_date, defaults accuracy, and replies nothing", async () => {
    const { person } = await paired();
    const reply = await onLocation(db(), locMsg(person.telegramId, { edit_date: SEC - 5 }), NOW);
    expect(reply.send).toEqual([]);
    const input = vi.mocked(syncDevice).mock.calls[0][2];
    expect(input.pings[0]).toMatchObject({ recordedAt: (SEC - 5) * 1000, accuracy: 50, heading: null });
  });

  it("ignores a static location with a short reply", async () => {
    const { person } = await paired();
    const reply = await onLocation(db(), locMsg(person.telegramId, {}, { live_period: undefined }), NOW);
    expect(html(reply)).toMatch(/live location/i);
    expect(syncDevice).not.toHaveBeenCalled();
  });

  it("ignores unknown senders and edits without a location", async () => {
    const stranger = await makePerson(db());
    expect((await onLocation(db(), locMsg(stranger.telegramId), NOW)).send).toEqual([]);
    const { person } = await paired();
    const edit = { ...locMsg(person.telegramId, { edit_date: SEC }), location: undefined, text: "hi" };
    expect((await onLocation(db(), edit, NOW)).send).toEqual([]);
    expect(syncDevice).not.toHaveBeenCalled();
  });
});

describe("onLocation: tells the driver once why nothing is tracked", () => {
  const setup = async (assigned = true) => {
    const person = await makePerson(db());
    const ws = await makeWorkspace(db());
    await onPair(await ctxFor(person), await codeIn(ws.id));
    const [device] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    if (assigned) await assign(device);
    return { person, device };
  };
  const live = (person: Person, edit = true, over: Partial<TgMessage> = {}) =>
    locMsg(person.telegramId, edit ? { edit_date: SEC - 5, ...over } : over);

  it("a killed phone: one 'paused' reply, then silence for every later update; still syncs", async () => {
    const { person, device } = await setup();
    await db()
      .update(devices)
      .set({ killedAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(devices.id, device.id));
    const first = await onLocation(db(), live(person, false), NOW);
    expect(html(first)).toBe("The shuttle team has paused your tracking.");
    expect(html(first)).not.toMatch(/Got your live location/);
    for (let i = 0; i < 3; i++) expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    expect(syncDevice).toHaveBeenCalledTimes(4);
    expect(await notices(device.id)).toHaveLength(1);
  });

  it("a new kill is told again; a new share message while still killed is told once more", async () => {
    const { person, device } = await setup();
    const kill = (ms: number) =>
      db()
        .update(devices)
        .set({ killedAt: new Date(ms) })
        .where(eq(devices.id, device.id));
    await kill(NOW.getTime() - 120_000);
    expect(html(await onLocation(db(), live(person), NOW))).toMatch(/paused/);
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    await db().update(devices).set({ killedAt: null }).where(eq(devices.id, device.id));
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    await kill(NOW.getTime() - 30_000);
    expect(html(await onLocation(db(), live(person), NOW))).toMatch(/paused/);
    const reshare = await onLocation(db(), live(person, false, { message_id: 9 }), NOW);
    expect(html(reshare)).toMatch(/paused/);
    expect(await notices(device.id)).toHaveLength(3);
  });

  it("a revoked phone: one 'removed' reply asking for a new pairing code", async () => {
    const { person, device } = await setup();
    await db().update(devices).set({ revokedAt: NOW }).where(eq(devices.id, device.id));
    await unassign(device.id, NOW);
    const first = await onLocation(db(), live(person), NOW);
    expect(html(first)).toMatch(/removed from the shuttle.*new pairing code/);
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    expect(await notices(device.id)).toHaveLength(1);
  });

  it("a phone on no vehicle: one 'isn't on a shuttle yet'; assigned and un-assigned again is told again", async () => {
    const { person, device } = await setup(false);
    const first = await onLocation(db(), live(person, false), NOW);
    expect(html(first)).toBe("This phone isn't on a shuttle yet — ask the shuttle team to assign it.");
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);

    await assign(device);
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    await unassign(device.id, new Date(NOW.getTime() - 1000));
    expect(html(await onLocation(db(), live(person), NOW))).toMatch(/isn't on a shuttle yet/);
    expect((await onLocation(db(), live(person), NOW)).send).toEqual([]);
    expect(await notices(device.id)).toHaveLength(2);
  });

  it("an assigned, healthy phone gets the normal confirmation and no notice", async () => {
    const { person, device } = await setup();
    expect(html(await onLocation(db(), live(person, false), NOW))).toMatch(/Got your live location/);
    expect(await notices(device.id)).toHaveLength(0);
  });

  it("the notice is one audit row by the device (device.driver_notified)", async () => {
    const { person, device } = await setup(false);
    await onLocation(db(), live(person), NOW);
    const [row] = await notices(device.id);
    expect(row).toMatchObject({
      actorKind: "device",
      actorId: device.id,
      entity: "device",
      workspaceId: device.workspaceId,
    });
  });
});

describe("onLocation: sharing ended", () => {
  const setup = async () => {
    const person = await makePerson(db());
    const ws = await makeWorkspace(db());
    await onPair(await ctxFor(person), await codeIn(ws.id));
    const [device] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    await assign(device);
    return { person, device };
  };

  it("an edit that reaches date + live_period is the end: how to restart, once, ping still kept", async () => {
    const { person, device } = await setup();
    const msg = locMsg(person.telegramId, { date: SEC - 28800, edit_date: SEC }, { live_period: 28800 });
    const reply = await onLocation(db(), msg, NOW);
    expect(html(reply)).toMatch(/stopped/);
    expect(html(reply)).toMatch(/Share My Live Location/);
    expect(vi.mocked(syncDevice).mock.calls[0][2].pings[0]).toMatchObject({ recordedAt: SEC * 1000, lat: 15.67 });
    expect((await onLocation(db(), msg, NOW)).send).toEqual([]);
    expect(await notices(device.id)).toHaveLength(1);
  });

  it("an edit whose location lost live_period is the end too; a new share message can end again", async () => {
    const { person } = await setup();
    const stop = (id: number) =>
      locMsg(person.telegramId, { message_id: id, edit_date: SEC - 1 }, { live_period: undefined });
    expect(html(await onLocation(db(), stop(5), NOW))).toMatch(/Share My Live Location/);
    expect((await onLocation(db(), stop(5), NOW)).send).toEqual([]);
    expect(html(await onLocation(db(), stop(6), NOW))).toMatch(/Share My Live Location/);
    expect(vi.mocked(syncDevice)).toHaveBeenCalledTimes(3);
  });

  it("an ordinary update (inside its period, live_period kept) says nothing", async () => {
    const { person } = await setup();
    const msg = locMsg(person.telegramId, { date: SEC - 600, edit_date: SEC - 5 }, { live_period: 28800 });
    expect((await onLocation(db(), msg, NOW)).send).toEqual([]);
  });
});

describe("onLocation: which device a sender maps to", () => {
  it("a re-pair moves the link, so the old (revoked) device neither swallows pings nor is told anything", async () => {
    const person = await makePerson(db());
    const ctx = await ctxFor(person);
    const ws = await makeWorkspace(db());
    await onPair(ctx, await codeIn(ws.id));
    const [old] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    await db().update(devices).set({ revokedAt: NOW }).where(eq(devices.id, old.id));
    await onPair(ctx, await codeIn(ws.id, "New"));
    const [fresh] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    expect(fresh.id).not.toBe(old.id);
    await assign(fresh);

    const reply = await onLocation(db(), locMsg(person.telegramId), NOW);
    expect(html(reply)).toMatch(/Got your live location/);
    expect(vi.mocked(syncDevice).mock.calls[0][1]).toMatchObject({ id: fresh.id });
    expect(await notices(old.id)).toHaveLength(0);
  });

  it("a revoked device that was not re-paired stays linked, so its driver is told rather than ignored", async () => {
    const person = await makePerson(db());
    const ws = await makeWorkspace(db());
    await onPair(await ctxFor(person), await codeIn(ws.id));
    const [d] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
    await db().update(devices).set({ revokedAt: NOW }).where(eq(devices.id, d.id));
    expect(html(await onLocation(db(), locMsg(person.telegramId), NOW))).toMatch(/removed from the shuttle/);
    expect(vi.mocked(syncDevice).mock.calls[0][1]).toMatchObject({ id: d.id });
  });
});
