import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, devices } from "@/db/schema";
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

describe("onLocation", () => {
  const paired = async () => {
    const person = await makePerson(db());
    const ws = await makeWorkspace(db());
    await onPair(await ctxFor(person), await codeIn(ws.id));
    const [d] = await db()
      .select()
      .from(devices)
      .where(eq(devices.tokenHash, `telegram:${person.telegramId}`));
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
    const reply = await onLocation(
      db(),
      locMsg(person.telegramId, { edit_date: SEC - 5 }, { live_period: undefined }),
      NOW,
    );
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
