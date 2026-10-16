import type { PublicStatus } from "@eci-shuttle/shared";
import { attendee, line, makeService, makeSpot } from "@tests/factories/bot-attendee";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  outbox,
  people,
  routes,
  serviceVehicles,
  subscriptions,
  vehicleBreaks,
  vehicleState,
  vehicles,
} from "@/db/schema";
import { publicStatus } from "../public/status";
import { unsubscribe } from "./subscriptions";
import { runUpdates, setUpdateEvery, subscribeUpdates, UPDATE_EVERY_MS } from "./updates";

vi.mock("../public/status", () => ({ publicStatus: vi.fn() }));
const status = vi.mocked(publicStatus);

const db = () => testDb();
const NOW = new Date("2026-10-13T05:30:00Z"); // 11:00 IST
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

async function setup() {
  const ws = await makeWorkspace(db());
  const riva = await makeSpot(db(), ws.id);
  const circle = await makeSpot(db(), ws.id, { name: "The Circle", shortName: "Circle" });
  const person = await makePerson(db(), { firstName: "Asha" });
  return { ws, riva, circle, person, actor: attendee(person, ws.id) };
}

/** The public status with one answer line per spot. */
function world(spotsIn: { spotId: string; name: string; lines: ReturnType<typeof line>[] }[]): PublicStatus {
  return {
    workspace: { slug: "eci", name: "ECI", isLive: true },
    generatedAt: NOW.toISOString(),
    notices: [],
    spots: spotsIn.map((s) => ({
      spotId: s.spotId,
      name: s.name,
      shortName: s.name,
      notices: [],
      answers: s.lines,
      schedule: { notices: [], rows: [], loops: [] },
    })),
  };
}

const sent = (ws: string) => db().select().from(outbox).where(eq(outbox.workspaceId, ws));

beforeEach(() => status.mockReset());

describe("subscribeUpdates", () => {
  it("one open updates subscription per person: a new stop replaces the old one; audited", async () => {
    const { ws, riva, actor } = await setup();
    const a = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    expect(a).toMatchObject({ kind: "updates", spotId: riva.id, lastSentAt: NOW, cancelledAt: null });
    const again = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    expect(again.id).toBe(a.id);
    const b = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, later(1));
    expect(b.spotId).toBeNull();
    const [old] = await db().select().from(subscriptions).where(eq(subscriptions.id, a.id));
    expect(old.cancelledAt).toEqual(later(1));
    const rows = await db().select().from(auditLog).where(eq(auditLog.entityId, b.id));
    expect(rows[0]).toMatchObject({ action: "subscription.create" });
  });
});

describe("runUpdates", () => {
  it("every 15 min, while a shuttle runs, DMs the stop's answer with a stop button; none in between", async () => {
    const { ws, riva, person, actor } = await setup();
    const sub = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    status.mockResolvedValue(world([{ spotId: riva.id, name: "Riva", lines: [line({ serviceName: "Shuttle" })] }]));

    expect(await runUpdates(db(), later(10), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), new Date(NOW.getTime() + UPDATE_EVERY_MS), { workspaceId: ws.id })).toEqual({
      sent: 1,
      ended: 0,
    });
    const [job] = await sent(ws.id);
    expect(job.payload).toMatchObject({
      chatId: person.telegramId,
      kind: "update",
      personId: person.id,
      buttons: [[{ text: "Stop updates", callbackData: `nunsub:${sub.id}` }]],
    });
    expect((job.payload as { html: string }).html).toContain("<b>Riva</b>\nShuttle: here in <b>6 min</b>");
    // a second run in the same minute sends nothing more
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(29), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(30), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
  });

  it("all stops in one message; quiet outside shuttle hours, after /stop, or when the bot is blocked", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    const sub = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    const done = line({
      kind: "none",
      minutes: null,
      rangeLo: null,
      rangeHi: null,
      phaseText: "no more shuttles today",
    });
    const first = line({ kind: "timetable", minutes: null, phaseText: "first shuttle today", nextAtLabel: "08:30" });
    status.mockResolvedValue(
      world([
        { spotId: riva.id, name: "Riva", lines: [done] },
        { spotId: circle.id, name: "Circle", lines: [first] },
      ]),
    );
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });

    status.mockResolvedValue(
      world([
        { spotId: riva.id, name: "Riva", lines: [line()] },
        { spotId: circle.id, name: "Circle", lines: [line({ minutes: 12 })] },
      ]),
    );
    expect(await runUpdates(db(), later(16), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    const html = ((await sent(ws.id))[0].payload as { html: string }).html;
    expect(html).toContain("<b>Riva</b>");
    expect(html).toContain("<b>Circle</b>");

    await db().update(people).set({ blockedBotAt: NOW }).where(eq(people.id, person.id));
    expect(await runUpdates(db(), later(40), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    await db().update(people).set({ blockedBotAt: null }).where(eq(people.id, person.id));
    await unsubscribe(db(), actor, { workspaceId: ws.id, subscriptionId: sub.id }, later(41));
    expect(await runUpdates(db(), later(60), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
  });
});

describe("runUpdates: end of service", () => {
  const done = () =>
    line({ kind: "none", minutes: null, rangeLo: null, rangeHi: null, phaseText: "no more shuttles today" });
  const live = (riva: string) => world([{ spotId: riva, name: "Riva", lines: [line()] }]);

  it("after the day's last shuttle: one 'finished for today', then quiet; it starts again the next day", async () => {
    const { ws, riva, person, actor } = await setup();
    const sub = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    status.mockResolvedValue(world([{ spotId: riva.id, name: "Riva", lines: [done()] }]));
    // even before the 15 min are up
    expect(await runUpdates(db(), later(3), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 1 });
    const [job] = await sent(ws.id);
    expect(job.payload).toMatchObject({ chatId: person.telegramId, kind: "update" });
    expect((job.payload as { html: string }).html).toContain("finished for today");
    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(row).toMatchObject({ cancelledAt: null, dayEndedOn: "2026-10-13" });
    expect(await runUpdates(db(), later(20), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    // next morning, before and once the shuttle runs
    expect(await runUpdates(db(), later(22 * 60), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    status.mockResolvedValue(live(riva.id));
    expect(await runUpdates(db(), later(23 * 60), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
  });

  it("a day it got no update on (no shuttles, or subscribed after hours) stays quiet", async () => {
    const { ws, riva, actor } = await setup();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    status.mockResolvedValue(world([{ spotId: riva.id, name: "Riva", lines: [done()] }]));
    expect(await runUpdates(db(), later(24 * 60), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
  });

  it("before the first shuttle it just waits", async () => {
    const { ws, riva, actor } = await setup();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    const first = line({ kind: "timetable", minutes: null, phaseText: "first shuttle today", nextAtLabel: "08:30" });
    status.mockResolvedValue(world([{ spotId: riva.id, name: "Riva", lines: [first] }]));
    expect(await runUpdates(db(), later(20), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
  });
});

/** A real service with Shuttle 1 on it (route Riva → Circle → Riva), and the public answer for both stops. */
async function onDutyWorld() {
  const base = await setup();
  const { ws, riva, circle } = base;
  const svc = await makeService(db(), ws.id, [riva.id, circle.id, riva.id], "Shuttle");
  await db()
    .update(routes)
    .set({ typicalLegS: [450, 460] })
    .where(eq(routes.id, svc.routeId));
  const [bus] = await db().insert(vehicles).values({ workspaceId: ws.id, name: "Shuttle 1" }).returning();
  await db()
    .insert(serviceVehicles)
    .values({ workspaceId: ws.id, serviceId: svc.id, vehicleId: bus.id, startsAt: later(-60), endsAt: later(600) });
  const answer = (minutes: number) =>
    line({ serviceId: svc.id, serviceName: "Shuttle", vehicleName: "Shuttle 1", minutes });
  status.mockResolvedValue(
    world([
      { spotId: riva.id, name: "Riva", lines: [answer(0)] },
      { spotId: circle.id, name: "Circle", lines: [answer(12)] },
    ]),
  );
  const put = (over: Partial<typeof vehicleState.$inferInsert>) =>
    db()
      .insert(vehicleState)
      .values({
        vehicleId: bus.id,
        workspaceId: ws.id,
        serviceId: svc.id,
        ...over,
      } as typeof vehicleState.$inferInsert)
      .onConflictDoUpdate({ target: vehicleState.vehicleId, set: over });
  return { ...base, svc, bus, put };
}
describe("runUpdates: what the shuttle is doing", () => {
  const htmlOf = async (ws: string, i = 0) =>
    ((await sent(ws)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[i].payload as { html: string })
      .html;

  it("a shuttle waiting at a stop: says so, and promises a message when it moves", async () => {
    const { ws, riva, actor, put } = await onDutyWorld();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    await put({ phase: "at_spot", spotId: riva.id, since: later(10), lastPingAt: later(15) });
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    const html = await htmlOf(ws.id);
    expect(html).toContain("<b>The shuttle is waiting at Riva</b> for passengers.");
    expect(html).toContain("Once it leaves, it's about 8 min to Circle.");
    expect(html).toContain("I'll message you as soon as it starts moving.");
  });

  it("keeps that promise: an update as soon as it leaves a stop, without waiting 15 min; once per departure", async () => {
    const { ws, riva, circle, actor, put } = await onDutyWorld();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    await put({ phase: "at_spot", spotId: riva.id, since: later(-5), lastPingAt: later(4) });
    expect(await runUpdates(db(), later(4), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    await put({ phase: "en_route", spotId: riva.id, nextSpotId: circle.id, since: later(5), lastPingAt: later(6) });
    expect(await runUpdates(db(), later(6), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    expect(await htmlOf(ws.id)).toContain("<b>The shuttle is on its way to Circle</b> and should be there in about");
    expect(await runUpdates(db(), later(8), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    // and the 15 min count again from that message
    expect(await runUpdates(db(), later(20), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(21), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
  });

  it("on a break or out of sight: says so calmly instead of a stale position", async () => {
    const { ws, riva, bus, actor, put } = await onDutyWorld();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    await put({ phase: "at_spot", spotId: riva.id, since: later(-30), lastPingAt: later(-20) });
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    expect(await htmlOf(ws.id)).toContain("I can't see where the shuttle is right now.");

    await db()
      .insert(vehicleBreaks)
      .values({ workspaceId: ws.id, vehicleId: bus.id, startsAt: later(20) });
    expect(await runUpdates(db(), later(30), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    expect(await htmlOf(ws.id, 1)).toContain("<b>The shuttle is on a short break.</b>");
  });
});

describe("update frequency (every 15 or 30 min)", () => {
  const live = (riva: string) => world([{ spotId: riva, name: "Riva", lines: [line({ serviceName: "Shuttle" })] }]);

  it("defaults to 15; switching to 30 is audited and changes the cadence; switching back too", async () => {
    const { ws, riva, actor } = await setup();
    const sub = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    expect(sub.everyMin).toBe(15);
    status.mockResolvedValue(live(riva.id));

    const slow = await setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 30 }, later(1));
    expect(slow).toMatchObject({ id: sub.id, everyMin: 30 });
    const audits = await db().select().from(auditLog).where(eq(auditLog.entityId, sub.id));
    expect(audits.map((a) => a.action)).toEqual(["subscription.create", "subscription.update"]);
    expect(audits[1]).toMatchObject({ before: { everyMin: 15 }, after: { everyMin: 30 } });
    // the same value again changes nothing and writes no audit row
    await setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 30 }, later(2));
    expect(await db().select().from(auditLog).where(eq(auditLog.entityId, sub.id))).toHaveLength(2);

    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(29), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(30), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    expect(await runUpdates(db(), later(45), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });

    const fast = await setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 15 }, later(46));
    expect(fast.everyMin).toBe(15);
    expect(await runUpdates(db(), later(45), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
  });

  it("is kept when the person switches stop; without an open subscription it's NOT_FOUND", async () => {
    const { ws, riva, actor } = await setup();
    await expect(setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 30 }, NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    await setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 30 }, later(1));
    const all = await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, later(2));
    expect(all.everyMin).toBe(30);
    await expect(
      setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 20 as 15 }, later(3)),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("a 30-min subscriber gets the calm rhythm: no instant 'it just left' push, and no promise of one", async () => {
    const { ws, riva, circle, actor, put } = await onDutyWorld();
    await subscribeUpdates(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    await setUpdateEvery(db(), actor, { workspaceId: ws.id, everyMin: 30 }, later(1));
    await put({ phase: "at_spot", spotId: riva.id, since: later(10), lastPingAt: later(30) });
    expect(await runUpdates(db(), later(30), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
    const html = ((await sent(ws.id))[0].payload as { html: string }).html;
    expect(html).toContain("waiting at Riva");
    expect(html).not.toMatch(/as soon as|the moment it/i);
    await put({ phase: "en_route", spotId: riva.id, nextSpotId: circle.id, since: later(35), lastPingAt: later(36) });
    expect(await runUpdates(db(), later(36), { workspaceId: ws.id })).toEqual({ sent: 0, ended: 0 });
    expect(await runUpdates(db(), later(60), { workspaceId: ws.id })).toEqual({ sent: 1, ended: 0 });
  });
});
