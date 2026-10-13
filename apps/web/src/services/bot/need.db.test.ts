import type { PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { attendee, line, makeSpot } from "@tests/factories/bot-attendee";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptions } from "@/db/schema";
import type { Spot } from "@/db/types";
import { attendeeActor } from "../auth/actor";
import { publicStatus } from "../public/status";
import { onAttendeeCallback, onStop } from "./attendee";
import { onNeed } from "./need";
import type { BotContext, TgCallbackQuery } from "./types";

vi.mock("../public/status", () => ({ publicStatus: vi.fn(), spotAnswer: vi.fn() }));
vi.mock("../auth/actor", () => ({ attendeeActor: vi.fn() }));

const db = () => testDb();
const NOW = new Date("2026-10-13T05:30:00Z");

const pubSpot = (s: Spot, answers = [line()]): PublicSpot => ({
  spotId: s.id,
  name: s.name,
  shortName: s.shortName,
  notices: [],
  answers,
  schedule: { notices: [], rows: [], loops: [] },
});

async function setup() {
  const workspace = await makeWorkspace(db());
  const nanu = await makeSpot(db(), workspace.id, { name: "Nanu Resort", shortName: "Nanu" });
  const riva = await makeSpot(db(), workspace.id);
  const circle = await makeSpot(db(), workspace.id, { name: "The Circle", shortName: "Circle" });
  const person = await makePerson(db(), { firstName: "Asha" });
  const st: PublicStatus = {
    workspace: { slug: workspace.slug, name: workspace.name, isLive: true },
    generatedAt: NOW.toISOString(),
    notices: [],
    spots: [pubSpot(nanu), pubSpot(riva), pubSpot(circle)],
  };
  vi.mocked(publicStatus).mockResolvedValue(st);
  vi.mocked(attendeeActor).mockImplementation((p, w) => attendee(p, w));
  const ctx: BotContext = { db: db(), now: NOW, person, chatId: 4242, workspace };
  return { ctx, nanu, riva, circle, st };
}

const press = (id: string): TgCallbackQuery => ({ id: "cbq1", from: { id: 1 }, data: id });
const buttons = (r: { send: { buttons?: unknown[][] }[] }) =>
  (r.send[0]?.buttons ?? []).flat() as { text: string; callbackData: string }[];
const open = (ctx: BotContext) =>
  db()
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.personId, ctx.person.id),
        eq(subscriptions.kind, "pickup"),
        isNull(subscriptions.cancelledAt),
      ),
    );

beforeEach(() => vi.clearAllMocks());

describe("/need", () => {
  it("Where are you? → Where to? (the other stops) → Got it, with a cancel button", async () => {
    const { ctx, nanu, riva, circle } = await setup();
    const ask = await onNeed(ctx, null);
    expect(ask.send[0].html).toBe("Where are you?");
    expect(buttons(ask).map((b) => [b.text, b.callbackData])).toEqual([
      ["Nanu", `need:${nanu.id}`],
      ["Riva", `need:${riva.id}`],
      ["Circle", `need:${circle.id}`],
    ]);

    const to = await onAttendeeCallback(ctx, { action: "need", args: [riva.id] }, press("x"));
    expect(to.send[0].html).toBe("From <b>Riva</b>. Where to?");
    const toButtons = buttons(to);
    expect(toButtons.map((b) => b.text)).toEqual(["Nanu", "Circle"]);
    for (const b of toButtons) expect(Buffer.byteLength(b.callbackData)).toBeLessThanOrEqual(64);

    const circleButton = toButtons[1].callbackData.split(":");
    const done = await onAttendeeCallback(
      ctx,
      { action: "needto", args: circleButton.slice(1) },
      press(toButtons[1].callbackData),
    );
    expect(done.send[0].html).toBe(
      "Got it: a shuttle from Riva to Circle. The shuttle team knows. I'll message you when the shuttle is here.",
    );
    const [req] = await open(ctx);
    expect(req).toMatchObject({ spotId: riva.id, toSpotId: circle.id });
    expect(buttons(done)).toEqual([{ text: "Cancel request", callbackData: `needx:${req.id}` }]);

    const x = await onAttendeeCallback(ctx, { action: "needx", args: [req.id] }, press("x"));
    expect(x.send[0].html).toBe("OK, I've cancelled your shuttle request.");
    expect(await open(ctx)).toEqual([]);
  });

  it("/need riva circle in one go; a new one replaces the old; one stop asks where to; unknown asks where", async () => {
    const { ctx, nanu, riva, circle } = await setup();
    const one = await onNeed(ctx, "riva circle");
    expect(one.send[0].html).toContain("Got it: a shuttle from Riva to Circle.");
    const two = await onNeed(ctx, "nanu to riva beach");
    expect(two.send[0].html).toContain("from Nanu to Riva");
    expect(two.send[0].html).toContain("This replaces your earlier request.");
    expect((await open(ctx)).map((r) => [r.spotId, r.toSpotId])).toEqual([[nanu.id, riva.id]]);

    expect((await onNeed(ctx, "circle")).send[0].html).toBe("From <b>Circle</b>. Where to?");
    const unknown = await onNeed(ctx, "the moon");
    expect(unknown.send[0].html).toContain('I don\'t know a stop called "the moon"');
    expect(buttons(unknown)).toHaveLength(3);
    expect(circle.id).toBeTruthy();
  });

  it("no shuttle running now: says so and when the next one starts; stops without a shuttle now aren't offered", async () => {
    const { ctx, riva, circle, st } = await setup();
    const first = line({
      kind: "timetable",
      minutes: null,
      phaseText: "first shuttle today",
      nextAt: "2026-10-13T06:30:00.000Z",
      nextAtLabel: "12:00",
    });
    vi.mocked(publicStatus).mockResolvedValue({ ...st, spots: [pubSpot(riva, [first]), pubSpot(circle, [first])] });
    expect((await onNeed(ctx, null)).send[0].html).toBe(
      "No shuttle is running right now. The next one starts at 12:00.",
    );
    expect((await onNeed(ctx, "riva circle")).send[0].html).toBe(
      "No shuttle is running right now. The next one starts at 12:00.",
    );

    vi.mocked(publicStatus).mockResolvedValue({ ...st, spots: [pubSpot(riva), pubSpot(circle, [first])] });
    const ask = await onNeed(ctx, null);
    expect(buttons(ask).map((b) => b.text)).toEqual(["Riva"]);
    const to = await onAttendeeCallback(ctx, { action: "need", args: [riva.id] }, press("x"));
    expect(to.send[0].html).toBe("No other stop has a shuttle right now.");
  });

  it("/stop cancels the request and says so", async () => {
    const { ctx } = await setup();
    await onNeed(ctx, "riva circle");
    expect((await onStop(ctx)).send[0].html).toBe("Done. I've cancelled your shuttle request (Riva → Circle).");
    expect(await open(ctx)).toEqual([]);
    expect((await onStop(ctx)).send[0].html).toMatch(/nothing/i);
  });

  it("a stale 'where to' button is refused politely", async () => {
    const { ctx, riva } = await setup();
    const r = await onAttendeeCallback(ctx, { action: "needto", args: [riva.id, "deadbeef"] }, press("x"));
    expect(r.send).toEqual([]);
    expect(r.answerCallback).toMatchObject({ text: "This button has expired" });
    expect(await open(ctx)).toEqual([]);
  });
});
