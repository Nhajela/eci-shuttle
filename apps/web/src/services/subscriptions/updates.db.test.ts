import type { PublicStatus } from "@eci-shuttle/shared";
import { attendee, line, makeSpot } from "@tests/factories/bot-attendee";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, outbox, people, subscriptions } from "@/db/schema";
import { publicStatus } from "../public/status";
import { unsubscribe } from "./subscriptions";
import { runUpdates, subscribeUpdates, UPDATE_EVERY_MS } from "./updates";

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

    expect(await runUpdates(db(), later(10), { workspaceId: ws.id })).toEqual({ sent: 0 });
    expect(await runUpdates(db(), new Date(NOW.getTime() + UPDATE_EVERY_MS), { workspaceId: ws.id })).toEqual({
      sent: 1,
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
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 0 });
    expect(await runUpdates(db(), later(29), { workspaceId: ws.id })).toEqual({ sent: 0 });
    expect(await runUpdates(db(), later(30), { workspaceId: ws.id })).toEqual({ sent: 1 });
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
    expect(await runUpdates(db(), later(15), { workspaceId: ws.id })).toEqual({ sent: 0 });

    status.mockResolvedValue(
      world([
        { spotId: riva.id, name: "Riva", lines: [line()] },
        { spotId: circle.id, name: "Circle", lines: [line({ minutes: 12 })] },
      ]),
    );
    expect(await runUpdates(db(), later(16), { workspaceId: ws.id })).toEqual({ sent: 1 });
    const html = ((await sent(ws.id))[0].payload as { html: string }).html;
    expect(html).toContain("<b>Riva</b>");
    expect(html).toContain("<b>Circle</b>");

    await db().update(people).set({ blockedBotAt: NOW }).where(eq(people.id, person.id));
    expect(await runUpdates(db(), later(40), { workspaceId: ws.id })).toEqual({ sent: 0 });
    await db().update(people).set({ blockedBotAt: null }).where(eq(people.id, person.id));
    await unsubscribe(db(), actor, { workspaceId: ws.id, subscriptionId: sub.id }, later(41));
    expect(await runUpdates(db(), later(60), { workspaceId: ws.id })).toEqual({ sent: 0 });
  });
});
