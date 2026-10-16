import type { PublicSpot, PublicStatus } from "@eci-shuttle/shared";
import { attendee, line, makeSpot } from "@tests/factories/bot-attendee";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Spot } from "@/db/types";
import { attendeeActor } from "../auth/actor";
import { publicStatus, spotAnswer } from "../public/status";
import { mySubscriptions } from "../subscriptions/subscriptions";
import {
  onAttendeeCallback,
  onEvery,
  onShuttle,
  onSpot,
  onStop,
  onSubscribe,
  onUnsubscribe,
  onWelcome,
  renderAnswer,
} from "./attendee";
import type { BotContext } from "./types";

vi.mock("../public/status", () => ({ publicStatus: vi.fn(), spotAnswer: vi.fn() }));
vi.mock("../auth/actor", () => ({ attendeeActor: vi.fn() }));

const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");

const pubSpot = (s: Spot, over: Partial<PublicSpot> = {}): PublicSpot => ({
  spotId: s.id,
  name: s.name,
  shortName: s.shortName,
  notices: [],
  answers: [line()],
  schedule: { notices: [], rows: [], loops: [] },
  ...over,
});

async function setup(spotsOver: (riva: Spot, circle: Spot) => PublicSpot[] = (r, c) => [pubSpot(r), pubSpot(c)]) {
  const workspace = await makeWorkspace(db());
  const riva = await makeSpot(db(), workspace.id);
  const circle = await makeSpot(db(), workspace.id, { name: "The Circle", shortName: "Circle" });
  const person = await makePerson(db());
  const status: PublicStatus = {
    workspace: { slug: workspace.slug, name: workspace.name, isLive: true },
    generatedAt: NOW.toISOString(),
    notices: [],
    spots: spotsOver(riva, circle),
  };
  vi.mocked(publicStatus).mockResolvedValue(status);
  vi.mocked(spotAnswer).mockResolvedValue([line()]);
  vi.mocked(attendeeActor).mockImplementation((p, w) => attendee(p, w));
  const ctx: BotContext = { db: db(), now: NOW, person, chatId: 4242, workspace };
  return { ctx, riva, circle, status };
}

const buttonData = (r: { send: { buttons?: unknown[][] }[] }) =>
  (r.send[0].buttons ?? []).flat().map((b) => (b as { callbackData?: string }).callbackData);

beforeEach(() => vi.clearAllMocks());

describe("renderAnswer", () => {
  it("one line per service, like the page, escaped, never lateness", () => {
    const html = renderAnswer("Riva & co", [
      line(),
      line({
        serviceName: "Party <shuttle>",
        kind: "timetable",
        minutes: null,
        nextAtLabel: "22:00",
        phaseText: "live tracking off",
      }),
      line({ serviceName: "Night", kind: "none", minutes: null, phaseText: "no more shuttles today" }),
    ]);
    expect(html).toBe(
      "<b>Riva &amp; co</b>\n" +
        "To Circle: here in <b>6 min</b> (5–9) · live\n" +
        "Party &lt;shuttle&gt;: next scheduled 22:00 · live tracking off\n" +
        "Night: no more shuttles today",
    );
    expect(html).not.toMatch(/late|behind/i);
  });

  it("approx, here now, and no lines", () => {
    expect(renderAnswer("Riva", [line({ approx: true, rangeLo: 6, rangeHi: 6 })])).toContain(
      "here in <b>about 6 min</b> · live",
    );
    expect(renderAnswer("Riva", [line({ minutes: 0 })])).toContain("<b>here now</b> · live");
    expect(renderAnswer("Riva", [])).toBe("<b>Riva</b>\nNo shuttles from here today.");
  });
});

describe("onShuttle / onSpot", () => {
  it("/shuttle alone → spot buttons", async () => {
    const { ctx, riva, circle } = await setup();
    const r = await onShuttle(ctx, null);
    expect(r.send[0]).toMatchObject({ chatId: 4242, kind: "reply" });
    expect(buttonData(r)).toEqual([`spot:${riva.id}`, `spot:${circle.id}`]);
  });

  it("a spot name typed alone (any case, short or full name) → that spot's answer with buttons", async () => {
    const { ctx, riva, circle } = await setup();
    for (const typed of ["riva", " RIVA ", "riva beach"]) {
      const r = await onShuttle(ctx, typed);
      expect(r.send[0].html).toContain("<b>Riva Beach</b>\nTo Circle: here in <b>6 min</b>");
      expect(buttonData(r)).toEqual([
        `arrive:${riva.id}:5`,
        `arrive:${riva.id}:10`,
        `nsub:${riva.id}`,
        `spot:${circle.id}`,
      ]);
    }
  });

  it("unknown name → says so and offers the spots; no service today → says so", async () => {
    const { ctx } = await setup();
    const r = await onShuttle(ctx, "mars");
    expect(r.send[0].html).toContain("mars");
    expect(buttonData(r)).toHaveLength(2);
    const empty = await setup(() => []);
    expect((await onShuttle(empty.ctx, null)).send[0].html).toMatch(/no shuttles/i);
  });

  it("onSpot shows notices once each (everywhere, spot, service)", async () => {
    const n = (id: string, text: string) => ({
      id,
      text,
      severity: "urgent" as const,
      pinned: false,
      endsAt: null,
    });
    const { ctx, riva, status } = await setup((r, c) => [
      pubSpot(r, {
        notices: [n("00000000-0000-4000-8000-000000000002", "Road works")],
        answers: [line({ notices: [n("00000000-0000-4000-8000-000000000003", "Bus swap")] })],
      }),
      pubSpot(c),
    ]);
    status.notices.push(n("00000000-0000-4000-8000-000000000001", "Rain <today>"));
    const html = (await onSpot(ctx, riva.id)).send[0].html;
    expect(html).toContain("Rain &lt;today&gt;");
    expect(html).toContain("Road works");
    expect(html.match(/Bus swap/g)).toHaveLength(1);
  });

  it("a spot not served today → says so", async () => {
    const { ctx } = await setup();
    const r = await onSpot(ctx, "00000000-0000-4000-8000-00000000dead");
    expect(r.send[0].html).toMatch(/no shuttle/i);
  });
});

describe("buttons and /stop", () => {
  const press = (data: string) => ({ id: "cbq1", from: { id: 1 }, data });

  it("arrive → one-shot alert with lead minutes, confirmed with a cancel button", async () => {
    const { ctx, riva } = await setup();
    const r = await onAttendeeCallback(ctx, { action: "arrive", args: [riva.id, "10"] }, press("x"));
    expect(r.answerCallback).toMatchObject({ callbackQueryId: "cbq1" });
    expect(r.send[0].html).toContain("10 min from <b>Riva Beach</b>");
    const subs = await mySubscriptions(
      db(),
      attendee(ctx.person, ctx.workspace.id),
      { workspaceId: ctx.workspace.id },
      NOW,
    );
    expect(subs).toMatchObject([{ kind: "arrival_alert", spotId: riva.id, leadMin: 10 }]);
    expect(buttonData(r)).toEqual([`nunsub:${subs[0].id}`]);

    const off = await onAttendeeCallback(ctx, { action: "nunsub", args: [subs[0].id] }, press("x"));
    expect(off.answerCallback?.text).toMatch(/off/i);
    expect(
      await mySubscriptions(db(), attendee(ctx.person, ctx.workspace.id), { workspaceId: ctx.workspace.id }, NOW),
    ).toEqual([]);
  });

  it("a refused alert becomes an alert box, not a crash", async () => {
    const { ctx, riva } = await setup();
    vi.mocked(spotAnswer).mockResolvedValue([]);
    const r = await onAttendeeCallback(ctx, { action: "arrive", args: [riva.id] }, press("x"));
    expect(r.answerCallback).toMatchObject({ showAlert: true, text: expect.stringMatching(/today/) });
    expect(r.send).toEqual([]);
  });

  it("nsub for a spot and for all, then /stop turns everything off", async () => {
    const { ctx, riva } = await setup();
    const one = await onAttendeeCallback(ctx, { action: "nsub", args: [riva.id] }, press("x"));
    expect(one.send[0].html).toContain("Riva Beach");
    const all = await onAttendeeCallback(ctx, { action: "nsub", args: ["all"] }, press("x"));
    expect(all.send[0].html).toMatch(/every stop/);
    const actor = attendee(ctx.person, ctx.workspace.id);
    expect(await mySubscriptions(db(), actor, { workspaceId: ctx.workspace.id }, NOW)).toHaveLength(2);

    expect((await onStop(ctx)).send[0].html).toMatch(/turned off/i);
    expect(await mySubscriptions(db(), actor, { workspaceId: ctx.workspace.id }, NOW)).toEqual([]);
    expect((await onStop(ctx)).send[0].html).toMatch(/nothing/i);
  });

  it("spot button → that spot's answer", async () => {
    const { ctx, circle } = await setup();
    const r = await onAttendeeCallback(ctx, { action: "spot", args: [circle.id] }, press("x"));
    expect(r.answerCallback).toEqual({ callbackQueryId: "cbq1" });
    expect(r.send[0].html).toContain("<b>The Circle</b>");
  });
});

describe("/subscribe", () => {
  const query = { id: "q1", from: { id: 1 }, data: "" } as never;
  it("asks which stop (or all), then subscribes with the answer now and a stop button", async () => {
    const { ctx, riva } = await setup();
    const ask = await onSubscribe(ctx, null);
    expect(ask.send[0].html).toContain("every 15 min");
    expect(buttonData(ask)).toEqual([`usub:${riva.id}`, expect.stringMatching(/^usub:/), "usub:all"]);

    const r = await onAttendeeCallback(ctx, { action: "usub", args: [riva.id] }, query);
    expect(r.send[0].html).toContain("<b>Riva Beach</b>");
    expect(r.send[0].html).toContain("every 15 min");
    const [sub] = await mySubscriptions(
      db(),
      attendee(ctx.person, ctx.workspace.id),
      { workspaceId: ctx.workspace.id },
      NOW,
    );
    expect(sub).toMatchObject({ kind: "updates", spotId: riva.id });
    expect(buttonData(r)).toEqual([`nunsub:${sub.id}`, "every:30"]);
  });

  it("'/subscribe riva' subscribes straight away; all stops too", async () => {
    const { ctx, riva } = await setup();
    const r = await onSubscribe(ctx, "riva");
    expect(r.send[0].html).toContain("every 15 min");
    const all = await onAttendeeCallback(ctx, { action: "usub", args: ["all"] }, query);
    expect(all.send[0].html).toContain("every stop");
    const subs = await mySubscriptions(
      db(),
      attendee(ctx.person, ctx.workspace.id),
      { workspaceId: ctx.workspace.id },
      NOW,
    );
    expect(subs.map((x) => x.spotId)).toEqual([null]);
    expect(riva).toBeTruthy();
  });
});

describe("welcome (plain /start)", () => {
  const WELCOME =
    "Welcome to the shuttle bot! Now you'll get updates every 15 minutes about where the shuttle is. Just send 'stop' or 'unsubscribe' whenever you want to stop.";
  const me = (ctx: BotContext) => attendee(ctx.person, ctx.workspace.id);

  it("subscribes to every stop straight away, then shows where the shuttle is now, with a stop button", async () => {
    const { ctx } = await setup();
    const r = await onWelcome(ctx);
    expect(r.send).toHaveLength(1);
    expect(r.send[0].html.startsWith(WELCOME)).toBe(true);
    expect(r.send[0].html).toContain("<b>Riva Beach</b>");
    expect(r.send[0].html).toContain("<b>The Circle</b>");
    const subs = await mySubscriptions(db(), me(ctx), { workspaceId: ctx.workspace.id }, NOW);
    expect(subs.map((x) => [x.kind, x.spotId])).toEqual([["updates", null]]);
    expect(buttonData(r)).toEqual([`nunsub:${subs[0].id}`, "every:30"]);
  });

  it("a second /start keeps the one subscription", async () => {
    const { ctx } = await setup();
    await onWelcome(ctx);
    await onWelcome(ctx);
    expect(await mySubscriptions(db(), me(ctx), { workspaceId: ctx.workspace.id }, NOW)).toHaveLength(1);
  });

  it("after the day's last shuttle it still subscribes and says updates start when it runs tomorrow", async () => {
    const { ctx } = await setup((r, c) =>
      [r, c].map((s) =>
        pubSpot(s, { answers: [line({ kind: "none", minutes: null, phaseText: "no more shuttles today" })] }),
      ),
    );
    const r = await onWelcome(ctx);
    expect(r.send[0].html.startsWith(WELCOME)).toBe(true);
    expect(r.send[0].html).toContain("finished for today");
    expect(await mySubscriptions(db(), me(ctx), { workspaceId: ctx.workspace.id }, NOW)).toHaveLength(1);
  });

  it("no shuttle stops set up: says so and subscribes nobody", async () => {
    const { ctx } = await setup(() => []);
    const r = await onWelcome(ctx);
    expect(r.send[0].html).toBe("No shuttles are running today.");
    expect(await mySubscriptions(db(), me(ctx), { workspaceId: ctx.workspace.id }, NOW)).toEqual([]);
  });
});

describe("update rhythm: every 15 or 30 min", () => {
  const query = { id: "q1", from: { id: 1 }, data: "" } as never;
  const mine = (ctx: BotContext) =>
    mySubscriptions(db(), attendee(ctx.person, ctx.workspace.id), { workspaceId: ctx.workspace.id }, NOW);

  it("without updates on, /every30 says to /start first", async () => {
    const { ctx } = await setup();
    expect((await onEvery(ctx, 30)).send[0].html).toMatch(/\/start/);
    expect(await mine(ctx)).toEqual([]);
  });

  it("the welcome and /subscribe offer the slower rhythm; the button switches it and confirms in one line", async () => {
    const { ctx } = await setup();
    const w = await onWelcome(ctx);
    const [sub] = await mine(ctx);
    expect(buttonData(w)).toEqual([`nunsub:${sub.id}`, "every:30"]);
    expect(w.send[0].html).toContain("every 15 minutes");

    const slow = await onAttendeeCallback(ctx, { action: "every", args: ["30"] }, query);
    expect(slow.answerCallback).toMatchObject({ callbackQueryId: "q1" });
    expect(slow.send).toHaveLength(1);
    expect(slow.send[0].html).toMatch(/30 min/);
    expect(slow.send[0].html.split("\n")).toHaveLength(1);
    expect(buttonData(slow)).toEqual(["every:15"]);
    expect((await mine(ctx))[0]).toMatchObject({ id: sub.id, everyMin: 30 });

    // re-subscribing to one stop keeps the rhythm and says so
    const r = await onSubscribe(ctx, "riva");
    expect(r.send[0].html).toContain("every 30 min");
    expect(buttonData(r)).toEqual([expect.stringMatching(/^nunsub:/), "every:15"]);

    const fast = await onEvery(ctx, 15);
    expect(fast.send[0].html).toMatch(/15 min/);
    expect(buttonData(fast)).toEqual(["every:30"]);
    expect((await mine(ctx))[0].everyMin).toBe(15);
  });

  it("a bad value on the button is refused as an alert, not a crash", async () => {
    const { ctx } = await setup();
    await onWelcome(ctx);
    const r = await onAttendeeCallback(ctx, { action: "every", args: ["20"] }, query);
    expect(r.send).toEqual([]);
    expect(r.answerCallback).toMatchObject({ showAlert: true });
  });
});

describe("/unsubscribe and after hours", () => {
  it("/unsubscribe ends the 15-min updates only", async () => {
    const { ctx, riva } = await setup();
    const me = attendee(ctx.person, ctx.workspace.id);
    const mine = () => mySubscriptions(db(), me, { workspaceId: ctx.workspace.id }, NOW);
    expect((await onUnsubscribe(ctx)).send[0].html).toContain("weren't getting");
    await onSubscribe(ctx, "riva");
    await onAttendeeCallback(ctx, { action: "nsub", args: [riva.id] }, { id: "q", from: { id: 1 }, data: "" } as never);
    expect((await onUnsubscribe(ctx)).send[0].html).toContain("No more shuttle updates");
    expect((await mine()).map((s) => s.kind)).toEqual(["notices"]);
  });

  it("subscribing after the day's last shuttle says updates start when it runs tomorrow", async () => {
    const { ctx } = await setup((r, c) =>
      [r, c].map((s) =>
        pubSpot(s, { answers: [line({ kind: "none", minutes: null, phaseText: "no more shuttles today" })] }),
      ),
    );
    const r = await onSubscribe(ctx, "riva");
    expect(r.send[0].html).toContain("finished for today");
  });
});
