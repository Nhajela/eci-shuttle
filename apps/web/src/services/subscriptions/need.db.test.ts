import type { PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { makeVehicle } from "@tests/factories/alerts";
import { attendee, line, makeService, makeSpot } from "@tests/factories/bot-attendee";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertPrefs, auditLog, outbox, subscriptions, vehicleState } from "@/db/schema";
import type { Spot } from "@/db/types";
import { publicStatus, spotAnswer } from "../public/status";
import { PICKUP_MAX_MS, requestPickup, runPickups, waitingAtSpots } from "./need";
import { unsubscribe } from "./subscriptions";

vi.mock("../public/status", () => ({ publicStatus: vi.fn(), spotAnswer: vi.fn() }));
const status = vi.mocked(publicStatus);
const answer = vi.mocked(spotAnswer);

const db = () => testDb();
const NOW = new Date("2026-10-13T05:30:00Z"); // 11:00 IST
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

const pubSpot = (s: Spot, answers = [line()]): PublicSpot => ({
  spotId: s.id,
  name: s.name,
  shortName: s.shortName,
  notices: [],
  answers,
  schedule: { notices: [], rows: [], loops: [] },
});

function world(list: PublicSpot[]): PublicStatus {
  return {
    workspace: { slug: "eci", name: "ECI", isLive: true },
    generatedAt: NOW.toISOString(),
    notices: [],
    spots: list,
  };
}

async function setup() {
  const ws = await makeWorkspace(db());
  const riva = await makeSpot(db(), ws.id);
  const circle = await makeSpot(db(), ws.id, { name: "The Circle", shortName: "Circle" });
  const nanu = await makeSpot(db(), ws.id, { name: "Nanu Resort", shortName: "Nanu" });
  const person = await makePerson(db(), { firstName: "Asha", username: "asha" });
  status.mockResolvedValue(world([pubSpot(nanu), pubSpot(riva), pubSpot(circle)]));
  return { ws, riva, circle, nanu, person, actor: attendee(person, ws.id) };
}

const jobs = (ws: string) => db().select().from(outbox).where(eq(outbox.workspaceId, ws));
const htmlOf = (j: { payload: unknown }) => (j.payload as { html: string }).html;

beforeEach(() => {
  status.mockReset();
  answer.mockReset();
  answer.mockResolvedValue([line()]);
});

describe("requestPickup", () => {
  it("opens a pickup from → to for 60 min, audited", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    const r = await requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id }, NOW);
    expect(r.replaced).toBe(false);
    expect(r.request).toMatchObject({
      personId: person.id,
      kind: "pickup",
      spotId: riva.id,
      toSpotId: circle.id,
      expiresAt: new Date(NOW.getTime() + PICKUP_MAX_MS),
      firedAt: null,
      cancelledAt: null,
    });
    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, r.request.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "subscription.create", actorKind: "attendee" });
  });

  it("alerts ops when the waiting count at a stop reaches 3, 6, …: whole picture, once per multiple", async () => {
    const { ws, riva, circle, nanu } = await setup();
    const { person: ops } = await makeAdmin(db(), ws.id, "ops");
    const bus = await makeVehicle(db(), ws.id, { name: "Shuttle 1" });
    await db().insert(vehicleState).values({
      vehicleId: bus.id,
      workspaceId: ws.id,
      phase: "at_spot",
      spotId: circle.id,
      lastPingAt: NOW,
    });
    await makeVehicle(db(), ws.id, { name: "Shuttle 2" });
    const names = ["Asha", "Ben", "Chi", "Dev", "Eli", "Fay", "Gus"];
    const alertsTo = async () =>
      (await jobs(ws.id)).filter((j) => (j.payload as { chatId: number }).chatId === ops.telegramId);
    const counts: number[] = [];
    for (const [k, firstName] of names.entries()) {
      const p = await makePerson(db(), { firstName, username: null });
      const to = k === 2 ? nanu.id : circle.id;
      await requestPickup(
        db(),
        attendee(p, ws.id),
        { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: to },
        later(k),
      );
      counts.push((await alertsTo()).length);
    }
    expect(counts).toEqual([0, 0, 1, 1, 1, 2, 2]);
    const [third, sixth] = await alertsTo();
    expect(htmlOf(third)).toBe(
      "🙋 <b>3 people waiting at Riva</b>\n" +
        "Asha → Circle, Ben → Circle, Chi → Nanu · waiting since 11:00\n" +
        "Shuttle 1: at Circle\n" +
        "Shuttle 2: no position yet",
    );
    expect(third.payload).toMatchObject({ kind: "alert" });
    expect(htmlOf(sixth)).toContain(
      "🙋 <b>6 people waiting at Riva</b>\nAsha → Circle, Ben → Circle, Chi → Nanu, Dev → Circle, Eli → Circle (+1 more)",
    );
  });

  it("no alert when someone re-requests at the same stop; a drop below 3 and back alerts again", async () => {
    const { ws, riva, circle, nanu } = await setup();
    const { person: ops } = await makeAdmin(db(), ws.id, "ops");
    const ppl = await Promise.all(["A", "B", "C", "D"].map((firstName) => makePerson(db(), { firstName })));
    const ask = (k: number, min: number, to = circle.id) =>
      requestPickup(
        db(),
        attendee(ppl[k], ws.id),
        { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: to },
        later(min),
      );
    const alerts = async () =>
      (await jobs(ws.id)).filter((j) => (j.payload as { chatId: number }).chatId === ops.telegramId).length;
    await ask(0, 0);
    await ask(1, 1);
    const c = await ask(2, 2);
    expect(await alerts()).toBe(1);
    await ask(2, 3, nanu.id); // same stop, new destination: still 3 waiting
    expect(await alerts()).toBe(1);
    await unsubscribe(db(), attendee(ppl[2], ws.id), { workspaceId: ws.id, subscriptionId: "all" }, later(4));
    expect(c.request.id).toBeTruthy();
    await ask(3, 5);
    expect(await alerts()).toBe(2);
  });

  it("respects alert prefs: an admin who turned pickup_request off gets nothing", async () => {
    const { ws, riva, circle } = await setup();
    const { person: admin } = await makeAdmin(db(), ws.id);
    await db()
      .insert(alertPrefs)
      .values({ personId: admin.id, workspaceId: ws.id, kinds: ["silent"] });
    for (const firstName of ["A", "B", "C"]) {
      const p = await makePerson(db(), { firstName });
      await requestPickup(
        db(),
        attendee(p, ws.id),
        { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id },
        NOW,
      );
    }
    expect(await jobs(ws.id)).toHaveLength(0);
  });

  it("one open request per person: a new one replaces the old", async () => {
    const { ws, riva, circle, nanu, actor } = await setup();
    const a = await requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id }, NOW);
    const b = await requestPickup(
      db(),
      actor,
      { workspaceId: ws.id, fromSpotId: nanu.id, toSpotId: riva.id },
      later(2),
    );
    expect(b.replaced).toBe(true);
    const [old] = await db().select().from(subscriptions).where(eq(subscriptions.id, a.request.id));
    expect(old.cancelledAt).toEqual(later(2));
    const open = await db()
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.personId, actor.id), eq(subscriptions.kind, "pickup")));
    expect(open.filter((s) => !s.cancelledAt).map((s) => s.id)).toEqual([b.request.id]);
  });

  it("refuses when no shuttle is running now (saying when the first one is), or a stop it doesn't serve now", async () => {
    const { ws, riva, circle, nanu, actor } = await setup();
    const first = line({
      kind: "timetable",
      minutes: null,
      phaseText: "first shuttle today",
      nextAt: "2026-10-13T06:30:00.000Z",
      nextAtLabel: "12:00",
    });
    status.mockResolvedValue(world([pubSpot(riva, [first]), pubSpot(circle, [first])]));
    const input = { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id };
    await expect(requestPickup(db(), actor, input, NOW)).rejects.toMatchObject({
      code: "INVALID",
      message: "😴 No shuttle is running right now. The next one starts at 12:00.",
    });

    status.mockResolvedValue(world([pubSpot(riva), pubSpot(circle)]));
    await expect(
      requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: nanu.id, toSpotId: circle.id }, NOW),
    ).rejects.toMatchObject({ code: "INVALID", message: "No shuttle stops at Nanu right now." });
    await expect(
      requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: riva.id }, NOW),
    ).rejects.toMatchObject({ code: "INVALID" });
    expect(await db().select().from(subscriptions).where(eq(subscriptions.workspaceId, ws.id))).toHaveLength(0);
  });

  it("only the attendee themselves", async () => {
    const { ws, riva, circle } = await setup();
    const { actor: admin } = await makeAdmin(db(), ws.id);
    await expect(
      requestPickup(db(), admin, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id }, NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("runPickups", () => {
  it("DMs 'here' and closes the request when a shuttle is at the pickup spot; once only", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    const { request } = await requestPickup(
      db(),
      actor,
      { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id },
      NOW,
    );
    answer.mockResolvedValue([line({ minutes: 25 })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(1))).toEqual({ fired: 0, onTheWay: 0, expired: 0 });

    answer.mockResolvedValue([line({ minutes: 3 }), line({ minutes: 0, phaseText: "here now" })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(2))).toEqual({ fired: 1, onTheWay: 0, expired: 0 });
    expect(answer).toHaveBeenCalledWith(expect.anything(), ws.id, riva.id, later(2));
    const dms = (await jobs(ws.id)).filter((j) => (j.payload as { chatId: number }).chatId === person.telegramId);
    // at the same moment as "on the way" would be: only "here"
    expect(dms).toHaveLength(1);
    expect(dms[0].dedupeKey).toBe(`need-here:${request.id}`);
    expect(dms[0].payload).toMatchObject({ kind: "arrival", personId: person.id });
    expect(htmlOf(dms[0])).toBe("🚐 The shuttle is here at <b>Riva</b> — hop on!");
    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, request.id));
    expect(row.firedAt).toEqual(later(2));
    expect(await runPickups(db(), { workspaceId: ws.id }, later(3))).toEqual({ fired: 0, onTheWay: 0, expired: 0 });
  });

  it("'on the way' once when the live ETA is ≤ 10 min, then 'here'", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    const { request } = await requestPickup(
      db(),
      actor,
      { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id },
      NOW,
    );
    answer.mockResolvedValue([line({ minutes: 6, approx: true })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(1))).toEqual({ fired: 0, onTheWay: 1, expired: 0 });
    answer.mockResolvedValue([line({ minutes: 2 })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(2))).toEqual({ fired: 0, onTheWay: 0, expired: 0 });
    answer.mockResolvedValue([line({ minutes: 0 })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(5))).toEqual({ fired: 1, onTheWay: 0, expired: 0 });
    const dms = (await jobs(ws.id)).filter((j) => (j.payload as { chatId: number }).chatId === person.telegramId);
    expect(dms.map((j) => j.dedupeKey)).toEqual([`need-way:${request.id}`, `need-here:${request.id}`]);
    expect(htmlOf(dms[0])).toBe("🚐 The shuttle is on its way to <b>Riva</b>, about 6 min.");
    expect(htmlOf(dms[0])).not.toMatch(/late/i);
  });

  it("'on the way' when a fresh en-route vehicle on a public service has the pickup as its next stop", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    await requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id }, NOW);
    const svc = await makeService(db(), ws.id, [circle.id, riva.id]);
    const bus = await makeVehicle(db(), ws.id);
    const state = {
      vehicleId: bus.id,
      workspaceId: ws.id,
      serviceId: svc.id,
      phase: "en_route" as const,
      nextSpotId: riva.id,
      lastPingAt: new Date(later(1).getTime() - 3 * 60_000), // stale
    };
    await db().insert(vehicleState).values(state);
    answer.mockResolvedValue([line({ minutes: 14 })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(1))).toMatchObject({ onTheWay: 0 });
    await db()
      .update(vehicleState)
      .set({ lastPingAt: later(1) })
      .where(eq(vehicleState.vehicleId, bus.id));
    expect(await runPickups(db(), { workspaceId: ws.id }, later(1))).toMatchObject({ onTheWay: 1 });
    const dm = (await jobs(ws.id)).find((j) => (j.payload as { chatId: number }).chatId === person.telegramId);
    expect(dm && htmlOf(dm)).toBe("🚐 The shuttle is on its way to <b>Riva</b>, 14 min.");
  });

  it("expires after 60 min and tells the person; cancelled ones are left alone", async () => {
    const { ws, riva, circle, nanu, person, actor } = await setup();
    const { request } = await requestPickup(
      db(),
      actor,
      { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id },
      NOW,
    );
    const other = await makePerson(db());
    const gone = await requestPickup(
      db(),
      attendee(other, ws.id),
      { workspaceId: ws.id, fromSpotId: nanu.id, toSpotId: circle.id },
      NOW,
    );
    await unsubscribe(db(), attendee(other, ws.id), { workspaceId: ws.id, subscriptionId: gone.request.id }, later(5));

    answer.mockResolvedValue([line({ minutes: 0 })]);
    expect(await runPickups(db(), { workspaceId: ws.id }, later(60))).toEqual({ fired: 0, onTheWay: 0, expired: 1 });
    const dm = (await jobs(ws.id)).find((j) => j.dedupeKey === `need-end:${request.id}`);
    expect(dm?.payload).toMatchObject({ chatId: person.telegramId });
    expect(dm && htmlOf(dm)).toBe(
      "⏳ Your request for a shuttle from Riva to Circle has expired after 60 min. Send /need if you still need one.",
    );
    expect(dm && htmlOf(dm)).not.toMatch(/late/i);
    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, request.id));
    expect(row.cancelledAt).toEqual(later(60));
  });
});

describe("waitingAtSpots", () => {
  it("viewer+: open requests per stop, oldest first, without fired, cancelled or expired ones", async () => {
    const { ws, riva, circle, nanu, actor } = await setup();
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");
    const ravi = await makePerson(db(), { firstName: "Ravi", username: null });
    const old = await makePerson(db(), { firstName: "Old" });
    await requestPickup(
      db(),
      attendee(old, ws.id),
      { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: nanu.id },
      NOW,
    );
    await requestPickup(
      db(),
      attendee(ravi, ws.id),
      { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: nanu.id },
      later(40),
    );
    await requestPickup(db(), actor, { workspaceId: ws.id, fromSpotId: riva.id, toSpotId: circle.id }, later(50));
    await requestPickup(
      db(),
      attendee(old, ws.id),
      { workspaceId: ws.id, fromSpotId: circle.id, toSpotId: nanu.id },
      later(10),
    );

    const out = await waitingAtSpots(db(), viewer, { workspaceId: ws.id }, later(75));
    expect(out).toEqual([
      {
        spotId: riva.id,
        spotName: "Riva",
        count: 2,
        people: [
          { requestId: expect.any(String), name: "Ravi", toSpotName: "Nanu", since: later(40) },
          { requestId: expect.any(String), name: "Asha (@asha)", toSpotName: "Circle", since: later(50) },
        ],
      },
    ]);

    const outsider = await makeWorkspace(db());
    const { actor: stranger } = await makeAdmin(db(), outsider.id);
    await expect(waitingAtSpots(db(), stranger, { workspaceId: ws.id }, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
