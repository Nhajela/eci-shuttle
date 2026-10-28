import { attendee, line, makeService, makeSpot } from "@tests/factories/bot-attendee";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, outbox, subscriptions } from "@/db/schema";
import { predictedPhase } from "../public/sight";
import { spotAnswer } from "../public/status";
import {
  ARRIVAL_ALERT_MAX_MS,
  mySubscriptions,
  noticeRecipients,
  runArrivalAlerts,
  subscribeArrival,
  subscribeNotices,
  subscriberCounts,
  unsubscribe,
} from "./subscriptions";

vi.mock("../public/status", () => ({ spotAnswer: vi.fn() }));
const answer = vi.mocked(spotAnswer);

const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  answer.mockReset();
  answer.mockResolvedValue([line()]);
});

async function setup() {
  const ws = await makeWorkspace(db());
  const riva = await makeSpot(db(), ws.id);
  const circle = await makeSpot(db(), ws.id, { name: "The Circle", shortName: "Circle" });
  const person = await makePerson(db(), { firstName: "Asha" });
  return { ws, riva, circle, person, actor: attendee(person, ws.id) };
}

const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId));
const jobsFor = (workspaceId: string) => db().select().from(outbox).where(eq(outbox.workspaceId, workspaceId));

describe("subscribeArrival", () => {
  it("creates a one-shot alert expiring in 2 h, audited subscription.create", async () => {
    const { ws, riva, person, actor } = await setup();
    const sub = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    expect(sub).toMatchObject({
      personId: person.id,
      kind: "arrival_alert",
      spotId: riva.id,
      serviceId: null,
      leadMin: 5,
      expiresAt: later(ARRIVAL_ALERT_MAX_MS),
      firedAt: null,
      cancelledAt: null,
    });
    const a = await audits(sub.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "subscription.create", actorKind: "attendee", channel: "telegram" });
  });

  it("a new alert for the same spot replaces the open one", async () => {
    const { ws, riva, actor } = await setup();
    const first = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    const second = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id, leadMin: 10 }, NOW);
    const rows = await db().select().from(subscriptions).where(eq(subscriptions.personId, actor.id));
    expect(rows.find((r) => r.id === first.id)?.cancelledAt).toEqual(NOW);
    expect(rows.find((r) => r.id === second.id)).toMatchObject({ cancelledAt: null, leadMin: 10 });
  });

  it("refuses a spot with no public service today, and a service not serving it", async () => {
    const { ws, riva, actor } = await setup();
    answer.mockResolvedValueOnce([]);
    await expect(subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW)).rejects.toMatchObject({
      code: "INVALID",
    });
    const svc = await makeService(db(), ws.id, [riva.id]);
    await expect(
      subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id, serviceId: svc.id }, NOW),
    ).rejects.toMatchObject({ code: "INVALID" });
    answer.mockResolvedValueOnce([line({ serviceId: svc.id })]);
    const ok = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id, serviceId: svc.id }, NOW);
    expect(ok.serviceId).toBe(svc.id);
  });

  it("another workspace's spot is NOT_FOUND; non-attendees are FORBIDDEN", async () => {
    const { ws, actor } = await setup();
    const other = await makeWorkspace(db());
    const far = await makeSpot(db(), other.id);
    await expect(subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: far.id }, NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const { actor: admin } = await makeAdmin(db(), ws.id);
    await expect(subscribeArrival(db(), admin, { workspaceId: ws.id, spotId: far.id }, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("subscribeNotices / unsubscribe / mySubscriptions", () => {
  it("is idempotent per spot (and for all spots)", async () => {
    const { ws, riva, actor } = await setup();
    const a = await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    const b = await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    expect(b.id).toBe(a.id);
    const all1 = await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    const all2 = await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    expect(all2.id).toBe(all1.id);
    expect(all1.id).not.toBe(a.id);
    expect(await audits(a.id)).toHaveLength(1);
  });

  it("lists open ones, cancels one (others' → NOT_FOUND) or all", async () => {
    const { ws, riva, circle, actor } = await setup();
    const n = await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: circle.id }, NOW);
    expect(await mySubscriptions(db(), actor, { workspaceId: ws.id }, NOW)).toHaveLength(2);
    // the arrival alert is expired 2 h later
    expect(await mySubscriptions(db(), actor, { workspaceId: ws.id }, later(ARRIVAL_ALERT_MAX_MS))).toHaveLength(1);

    const stranger = attendee(await makePerson(db()), ws.id);
    await expect(unsubscribe(db(), stranger, { workspaceId: ws.id, subscriptionId: n.id }, NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(await unsubscribe(db(), actor, { workspaceId: ws.id, subscriptionId: n.id }, NOW)).toBe(1);
    expect(await audits(n.id)).toHaveLength(2);
    expect(await unsubscribe(db(), actor, { workspaceId: ws.id, subscriptionId: "all" }, NOW)).toBe(1);
    expect(await mySubscriptions(db(), actor, { workspaceId: ws.id }, NOW)).toHaveLength(0);
    expect(await unsubscribe(db(), actor, { workspaceId: ws.id, subscriptionId: "all" }, NOW)).toBe(0);
  });
});

describe("runArrivalAlerts", () => {
  it("fires once when a live line is within lead minutes, with a Telegram message", async () => {
    const { ws, riva, person, actor } = await setup();
    const sub = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);

    answer.mockResolvedValue([line({ minutes: 8 }), line({ kind: "timetable", minutes: null })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(60_000))).toEqual({ fired: 0, expired: 0 });

    answer.mockResolvedValue([line({ minutes: 4, approx: true })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(120_000))).toEqual({ fired: 1, expired: 0 });
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(130_000))).toEqual({ fired: 0, expired: 0 });

    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(row.firedAt).toEqual(later(120_000));
    const jobs = await jobsFor(ws.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "telegram", dedupeKey: `arrival:${sub.id}` });
    expect(jobs[0].payload).toMatchObject({ chatId: person.telegramId, kind: "arrival", personId: person.id });
    const html = (jobs[0].payload as { html: string }).html;
    expect(html).toContain("about <b>4 min</b>");
    expect(html).toContain("Riva");
    expect(html).not.toMatch(/late|behind/i);
  });

  it("never fires on an estimate through a no-signal stretch (a guess is not 'time to wander over')", async () => {
    const { ws, riva, actor } = await setup();
    const sub = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    answer.mockResolvedValue([line({ minutes: 1, approx: true, phaseText: predictedPhase("Riva") })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(60_000))).toEqual({ fired: 0, expired: 0 });
    expect(await jobsFor(ws.id)).toHaveLength(0);
    // still armed: the first real fix within the lead time fires it
    answer.mockResolvedValue([line({ minutes: 3, approx: true })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(120_000))).toEqual({ fired: 1, expired: 0 });
    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(row.firedAt).toEqual(later(120_000));
  });

  it("only counts the subscribed service's line when set", async () => {
    const { ws, riva, actor } = await setup();
    const svc = await makeService(db(), ws.id, [riva.id], "Party shuttle");
    answer.mockResolvedValue([line({ serviceId: svc.id, minutes: 20 })]);
    await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id, serviceId: svc.id }, NOW);
    answer.mockResolvedValue([line({ minutes: 2 }), line({ serviceId: svc.id, minutes: 20 })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(1000))).toEqual({ fired: 0, expired: 0 });
  });

  it("expires after 2 h with an 'alert ended' message", async () => {
    const { ws, riva, actor } = await setup();
    const sub = await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    answer.mockResolvedValue([line({ minutes: 30 })]);
    expect(await runArrivalAlerts(db(), { workspaceId: ws.id }, later(ARRIVAL_ALERT_MAX_MS))).toMatchObject({
      expired: 1,
    });
    const [row] = await db().select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(row.cancelledAt).toEqual(later(ARRIVAL_ALERT_MAX_MS));
    const jobs = await jobsFor(ws.id);
    expect((jobs[0].payload as { html: string }).html).toContain("alert ended");
    // expiry is bookkeeping, not audited
    expect(await audits(sub.id)).toHaveLength(1);
  });
});

describe("noticeRecipients", () => {
  it("spot subscribers plus all-spot subscribers, distinct, minus blocked-bot people", async () => {
    const { ws, riva, circle, person, actor } = await setup();
    await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    const p2 = await makePerson(db());
    await subscribeNotices(db(), attendee(p2, ws.id), { workspaceId: ws.id, spotId: circle.id }, NOW);
    const blocked = await makePerson(db(), { blockedBotAt: NOW });
    await subscribeNotices(db(), attendee(blocked, ws.id), { workspaceId: ws.id, spotId: riva.id }, NOW);

    const ids = async (s: string[] | "all") => (await noticeRecipients(db(), ws.id, s)).map((p) => p.id).sort();
    expect(await ids([riva.id])).toEqual([person.id]);
    expect(await ids([circle.id])).toEqual([person.id, p2.id].sort());
    expect(await ids("all")).toEqual([person.id, p2.id].sort());
  });
});

describe("subscriberCounts", () => {
  it("counts open subscriptions per spot for viewers; attendees are refused", async () => {
    const { ws, riva, actor } = await setup();
    await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    await subscribeNotices(db(), actor, { workspaceId: ws.id, spotId: null }, NOW);
    await subscribeArrival(db(), actor, { workspaceId: ws.id, spotId: riva.id }, NOW);
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");
    const counts = await subscriberCounts(db(), viewer, { workspaceId: ws.id }, NOW);
    expect(counts).toEqual(
      expect.arrayContaining([
        { spotId: riva.id, notices: 1, arrivalAlerts: 1 },
        { spotId: null, notices: 1, arrivalAlerts: 0 },
      ]),
    );
    expect(counts).toHaveLength(2);
    await expect(subscriberCounts(db(), actor, { workspaceId: ws.id }, NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const open = await db()
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, ws.id), eq(subscriptions.kind, "arrival_alert")));
    expect(open).toHaveLength(1);
  });
});
