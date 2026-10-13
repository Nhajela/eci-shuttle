import type { Role } from "@eci-shuttle/shared";
import { makeDevice, makeService, makeSilence, makeSpot, makeVehicle } from "@tests/factories/bot-admin";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { memberships, workspaces } from "@/db/schema";
import type { Notice, Person, Workspace } from "@/db/types";
import { detectProblems } from "@/services/alerts/watchdog";
import { adminActor, resolveWorkspace } from "@/services/auth/actor";
import { addException, getSchedule } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { listVehicles } from "@/services/catalog/vehicles";
import { killPhone, listPhones, nudgePhone, silencePhone } from "@/services/devices/phones";
import { vehicleStates } from "@/services/ingest/ingest";
import { createNotice, listNotices } from "@/services/notices/notices";
import { type Actor, ServiceError, type TelegramButton } from "../kernel";
import { alertButtons, onAdminCallback, onNotice, onSetGroup, onSilence, onStatus, onToday, parseUntil } from "./admin";
import type { Callback } from "./callbacks";
import type { BotContext, TgCallbackQuery } from "./types";

// The services the bot calls are built by parallel tasks; here they are fakes, so these tests pin down only what
// the bot sends them and how it renders what they return. Workspace/role resolution is faked over the real DB.
vi.mock("@/services/auth/actor", () => ({ adminActor: vi.fn(), resolveWorkspace: vi.fn(), attendeeActor: vi.fn() }));
vi.mock("@/services/alerts/watchdog", () => ({ detectProblems: vi.fn() }));
vi.mock("@/services/catalog/schedule", () => ({ addException: vi.fn(), getSchedule: vi.fn() }));
vi.mock("@/services/catalog/spots", () => ({ listSpots: vi.fn() }));
vi.mock("@/services/catalog/vehicles", () => ({ listVehicles: vi.fn() }));
vi.mock("@/services/devices/phones", () => ({
  killPhone: vi.fn(),
  listPhones: vi.fn(),
  nudgePhone: vi.fn(),
  silencePhone: vi.fn(),
}));
vi.mock("@/services/ingest/ingest", () => ({ vehicleStates: vi.fn() }));
vi.mock("@/services/notices/notices", () => ({ createNotice: vi.fn(), listNotices: vi.fn() }));

const db = () => testDb();
/** Mon 12 Oct 2026, 10:00 IST */
const NOW = new Date("2026-10-12T04:30:00Z");
const at = (ist: string) => new Date(`2026-10-12T${ist}:00+05:30`);
const H = 3_600_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminActor).mockImplementation(async (d: Db, i): Promise<Actor> => {
    const [m] = await d
      .select()
      .from(memberships)
      .where(and(eq(memberships.personId, i.personId), eq(memberships.workspaceId, i.workspaceId)));
    if (!m) throw new ServiceError("FORBIDDEN", "You're not a member of this workspace.");
    return { kind: "admin", id: i.personId, workspaceId: i.workspaceId, role: m.role, channel: i.channel };
  });
  vi.mocked(resolveWorkspace).mockImplementation(async (d: Db, personId, slug) => {
    const rows = await d
      .select({ workspace: workspaces, role: memberships.role })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.personId, personId));
    return rows.find((r) => r.workspace.slug === slug) ?? rows.find((r) => r.workspace.isLive) ?? rows[0] ?? null;
  });
  vi.mocked(listNotices).mockResolvedValue([]);
});

/** A non-live workspace plus a member (live is unique per DB, and test files share one). */
async function setup(role: Role = "admin") {
  const ws = await makeWorkspace(db());
  const { person } = await makeAdmin(db(), ws.id, role);
  return { ws, person, ctx: ctxFor(person, ws) };
}
const ctxFor = (person: Person, workspace: Workspace): BotContext => ({
  db: db(),
  now: NOW,
  person,
  chatId: 42,
  workspace,
});
const query = (text?: string): TgCallbackQuery => ({
  id: "q1",
  from: { id: 1 },
  message: { message_id: 7, date: 0, chat: { id: 42, type: "private" }, text },
});
/** What Telegram puts in message.text for an HTML message: tags stripped, entities decoded. */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const datas = (buttons?: TelegramButton[][]) =>
  (buttons ?? []).flat().map((b) => ("callbackData" in b ? b.callbackData : b.url));
/** Hold each adminActor call until `n` presses have reached it, so the presses race from the same moment. */
function lineUp(n = 2) {
  const real = vi.mocked(adminActor).getMockImplementation();
  const waiting: (() => void)[] = [];
  vi.mocked(adminActor).mockImplementation(async (...a) => {
    await new Promise<void>((go) => {
      waiting.push(go);
      if (waiting.length === n) for (const g of waiting.splice(0)) g();
    });
    return (real as typeof adminActor)(...a);
  });
}
const actorArg = (fn: unknown) => (vi.mocked(fn as () => void).mock.calls[0] as unknown[])[1] as Actor;

describe("/setgroup", () => {
  const groupOf = async (id: string) =>
    (await db().select().from(workspaces).where(eq(workspaces.id, id)))[0].groupChatId;

  it("an admin in a group makes it the workspace's Telegram group (audited via updateWorkspace)", async () => {
    const { ws, ctx } = await setup("admin");
    const r = await onSetGroup({ ...ctx, chatId: -100123 }, [], true);
    expect(await groupOf(ws.id)).toBe(-100123);
    expect(r.send[0]).toMatchObject({ chatId: -100123 });
    expect(r.send[0].html).toContain("group notices");
  });

  it("refused in a private chat; ops can't change it", async () => {
    const { ws, ctx } = await setup("admin");
    expect((await onSetGroup(ctx, [], false)).send[0].html).toContain("in the group");
    expect(await groupOf(ws.id)).toBeNull();
    const ops = await setup("ops");
    await expect(onSetGroup({ ...ops.ctx, chatId: -100123 }, [], true)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("parseUntil", () => {
  it("relative hours and minutes", () => {
    expect(parseUntil("2h", NOW)).toEqual(new Date(+NOW + 2 * H));
    expect(parseUntil("45m", NOW)).toEqual(new Date(+NOW + 45 * 60_000));
  });
  it("HH:MM IST, the next occurrence", () => {
    expect(parseUntil("16:00", NOW)).toEqual(at("16:00"));
    expect(parseUntil("9:30", NOW)).toEqual(new Date(+at("09:30") + 24 * H));
  });
  it("anything else → null", () => {
    for (const s of ["0h", "abc", "25:00", "2d", ""]) expect(parseUntil(s, NOW)).toBeNull();
  });
});

describe("onStatus", () => {
  it("refuses people without a membership", async () => {
    const ws = await makeWorkspace(db());
    const person = await makePerson(db());
    await expect(onStatus(ctxFor(person, ws), [])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("each vehicle's phase, ETA, last seen, battery (IST), then the open problems", async () => {
    const { ws, ctx } = await setup("viewer");
    const bus1 = await makeVehicle(db(), ws.id, "Bus 1");
    const bus2 = await makeVehicle(db(), ws.id, "Bus <2>");
    const riva = await makeSpot(db(), ws.id, "Riva");
    const phone = await makeDevice(db(), ws.id, { battery: 54 });
    vi.mocked(listVehicles).mockResolvedValue([bus1, bus2]);
    vi.mocked(listSpots).mockResolvedValue([riva]);
    vi.mocked(vehicleStates).mockResolvedValue([
      {
        vehicleId: bus1.id,
        phase: "en_route",
        nextSpotId: riva.id,
        etaS: 350,
        lastPingAt: at("09:58"),
      } as never,
    ]);
    vi.mocked(listPhones).mockResolvedValue([{ device: phone, vehicle: bus1 } as never]);
    vi.mocked(detectProblems).mockResolvedValue([
      {
        kind: "silent",
        workspaceId: ws.id,
        vehicleId: bus2.id,
        deviceId: null,
        since: at("09:50"),
        message: "Bus 2 has been silent",
      },
    ]);

    const r = await onStatus(ctx, []);
    const html = r.send[0].html;
    expect(r.send[0]).toMatchObject({ chatId: 42, kind: "reply" });
    expect(html).toContain("<b>Bus 1</b>: to Riva in 6 min · seen 09:58 · battery 54%");
    expect(html).toContain("<b>Bus &lt;2&gt;</b>: no data yet");
    expect(html).toContain("Bus 2 has been silent (since 09:50)");
    expect(html).toContain(`TEST workspace: ${ws.slug}`);
    expect(actorArg(listVehicles)).toMatchObject({ channel: "telegram", workspaceId: ws.id });
    expect(vi.mocked(detectProblems).mock.calls[0]).toEqual([db(), ws.id, NOW]);
  });

  it("a trailing slug picks that workspace; one you're not in is refused", async () => {
    const { person, ctx } = await setup();
    const other = await makeWorkspace(db());
    await db().insert(memberships).values({ personId: person.id, workspaceId: other.id, role: "viewer" });
    for (const fn of [listVehicles, listSpots, listPhones, vehicleStates, detectProblems])
      vi.mocked(fn as () => Promise<unknown[]>).mockResolvedValue([]);
    const r = await onStatus(ctx, [other.slug]);
    expect(r.send[0].html).toContain("No vehicles yet.");
    expect(r.send[0].html).toContain("No problems.");
    expect(actorArg(listVehicles).workspaceId).toBe(other.id);
    await expect(onStatus(ctx, ["nope-slug"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("onToday", () => {
  async function today(role: Role) {
    const s = await setup(role);
    const svc = await makeService(db(), s.ws.id, "Riva ↔ Circle");
    const party = await makeService(db(), s.ws.id, "Party");
    const d = (hhmm: string, shiftedMin = 0, added = false) => ({
      serviceId: svc.id,
      date: "2026-10-12",
      at: +at(hhmm),
      planned: hhmm,
      shiftedMin,
      added,
    });
    vi.mocked(getSchedule).mockResolvedValue([
      {
        date: "2026-10-12",
        services: [
          {
            service: svc,
            vehicles: [],
            exceptions: [{ kind: "cancel_departure", departure: "11:00" } as never],
            departures: [d("10:00"), d("10:25", 5), d("10:40", 0, true)],
          },
          {
            service: party,
            vehicles: [],
            exceptions: [{ kind: "cancel_day", departure: null, note: "rain" } as never],
            departures: [],
          },
        ],
      },
    ]);
    return { ...s, svc, party, r: await onToday(s.ctx, []) };
  }

  it("today's services and departures with the exceptions marked", async () => {
    const { ws, r } = await today("viewer");
    const html = r.send[0].html;
    expect(vi.mocked(getSchedule).mock.calls[0][2]).toEqual({ workspaceId: ws.id, from: "2026-10-12", days: 1 });
    expect(html).toContain("<b>Riva ↔ Circle</b>\n10:00, 10:25 (+5), 10:40 (added)\nCancelled: 11:00");
    expect(html).toContain("<b>Party</b>: cancelled today (rain)");
    expect(r.send[0].buttons ?? []).toEqual([]);
  });

  it("ops get a cancel-the-day button for services still running", async () => {
    const { svc, r } = await today("ops");
    expect(datas(r.send[0].buttons)).toEqual([`cday:${svc.id}:20261012`]);
  });
});

describe("onSilence", () => {
  async function fleet() {
    const s = await setup("ops");
    const bus1 = await makeVehicle(db(), s.ws.id, "Bus 1");
    const bus10 = await makeVehicle(db(), s.ws.id, "Bus 10");
    const van = await makeVehicle(db(), s.ws.id, "Van");
    const phone = await makeDevice(db(), s.ws.id, { label: "Ravi's phone" });
    vi.mocked(listVehicles).mockResolvedValue([bus1, bus10, van]);
    vi.mocked(listPhones).mockResolvedValue([{ device: phone, vehicle: bus1 } as never]);
    return { ...s, phone };
  }

  it("silences the vehicle's phone until the time given", async () => {
    const { ws, phone, ctx } = await fleet();
    const r = await onSilence(ctx, ["bus", "1", "2h"]);
    expect(vi.mocked(silencePhone).mock.calls[0][2]).toEqual({
      workspaceId: ws.id,
      deviceId: phone.id,
      until: new Date(+NOW + 2 * H).toISOString(),
    });
    expect(actorArg(silencePhone)).toMatchObject({ channel: "telegram", role: "ops" });
    expect(r.send[0].html).toContain("Silenced Bus 1 (Ravi's phone) until 12:00");
  });

  it("asks which one when the name is ambiguous; says so when unknown or phoneless", async () => {
    const { ctx } = await fleet();
    expect((await onSilence(ctx, ["bus", "16:00"])).send[0].html).toContain("Which one? Bus 1, Bus 10");
    expect((await onSilence(ctx, ["tram", "16:00"])).send[0].html).toContain("No vehicle called");
    expect((await onSilence(ctx, ["van", "16:00"])).send[0].html).toContain("Van has no phone right now");
    expect((await onSilence(ctx, ["bus", "1"])).send[0].html).toContain("/silence");
    expect(silencePhone).not.toHaveBeenCalled();
  });
});

describe("/notice wizard", () => {
  const press = (ctx: BotContext, html: string, args: string[]) =>
    onAdminCallback(ctx, { action: "nw", args }, query(plain(html)));

  it("needs text, and the ops role", async () => {
    const { ctx } = await setup("ops");
    expect((await onNotice(ctx, "  ")).send[0].html).toContain("/notice Pickup");
    const viewer = await setup("viewer");
    await expect(onNotice(viewer.ctx, "Hi")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("placement → duration → severity → channels → Post, read back from the message itself", async () => {
    const { ws, ctx } = await setup("ops");
    const riva = await makeSpot(db(), ws.id, "Riva");
    vi.mocked(listSpots).mockResolvedValue([riva]);

    const start = await onNotice(ctx, "/notice Pickup at the <side> gate");
    let html = start.send[0].html;
    expect(html).toContain("Pickup at the &lt;side&gt; gate");
    expect(datas(start.send[0].buttons)).toEqual([
      "nw:pl:every",
      "nw:pl:sched",
      "nw:pl:admin",
      `nw:pl:${riva.id}`,
      "nw:x",
    ]);

    const steps: [string[], string[]][] = [
      [
        ["pl", riva.id],
        ["nw:du:1h", "nw:du:2h", "nw:du:4h", "nw:du:eod", "nw:du:none", "nw:x"],
      ],
      [
        ["du", "2h"],
        ["nw:sv:info", "nw:sv:heads_up", "nw:sv:urgent", "nw:x"],
      ],
      [
        ["sv", "urgent"],
        ["nw:ch:none", "nw:ch:sub", "nw:ch:grp", "nw:ch:pin", "nw:x"],
      ],
      [
        ["ch", "sub"],
        ["nw:post", "nw:x"],
      ],
    ];
    for (const [args, next] of steps) {
      const r = await press(ctx, html, args);
      expect(r.edit).toMatchObject({ chatId: 42, messageId: 7 });
      expect(r.answerCallback).toEqual({ callbackQueryId: "q1" });
      html = r.edit?.html ?? "";
      expect(datas(r.edit?.buttons)).toEqual(next);
    }
    expect(html).toContain("Where: Riva\nFor: 2 hours\nSeverity: Urgent\nSend to: Page + subscribers");

    const posted = await press(ctx, html, ["post"]);
    expect(vi.mocked(createNotice).mock.calls[0][2]).toEqual({
      workspaceId: ws.id,
      text: "Pickup at the <side> gate",
      severity: "urgent",
      placements: [`spot:${riva.id}`],
      channels: ["subscribers"],
      endsAt: new Date(+NOW + 2 * H).toISOString(),
    });
    expect(actorArg(createNotice)).toMatchObject({ channel: "telegram", workspaceId: ws.id });
    expect(posted.edit?.html).toContain("Notice posted");
    expect(posted.edit?.buttons ?? []).toEqual([]);
    // the posted message is no longer a draft: its old buttons expire
    expect((await press(ctx, posted.edit?.html ?? "", ["post"])).answerCallback?.text).toMatch(/expired/);
  });

  it("a second Post press of the same draft doesn't post twice", async () => {
    const { ws, person, ctx } = await setup("ops");
    const draft =
      "New notice\nRoad closed\n\nWhere: Everywhere\nFor: Rest of today\nSeverity: Info\nSend to: Page only";
    vi.mocked(listNotices).mockResolvedValue([
      {
        text: "Road closed",
        placements: ["everywhere"],
        createdByPersonId: person.id,
        createdAt: new Date(+NOW - 20_000),
      } as Notice,
    ]);
    const r = await onAdminCallback(ctx, { action: "nw", args: ["post"] }, query(draft));
    expect(createNotice).not.toHaveBeenCalled();
    expect(r.edit?.html).toContain("Notice posted");
    vi.mocked(listNotices).mockResolvedValue([]);
    await onAdminCallback(ctx, { action: "nw", args: ["post"] }, query(draft));
    expect(vi.mocked(createNotice).mock.calls[0][2]).toMatchObject({
      workspaceId: ws.id,
      placements: ["everywhere"],
      channels: [],
      endsAt: at("23:59").toISOString(),
    });
  });

  it("two Post presses at once still post once", async () => {
    const { person, ctx } = await setup("ops");
    const made: Notice[] = [];
    vi.mocked(listNotices).mockImplementation(async () => made);
    vi.mocked(createNotice).mockImplementation(async (_d, _a, i) => {
      await new Promise((r) => setTimeout(r, 50)); // widen the window between the check and the write
      const n = { ...i, createdByPersonId: person.id, createdAt: NOW } as unknown as Notice;
      made.push(n);
      return n;
    });
    const draft = "New notice\nRoad closed\n\nWhere: Everywhere\nFor: 1 hour\nSeverity: Info\nSend to: Page + group";
    lineUp();
    const press = () => onAdminCallback(ctx, { action: "nw", args: ["post"] }, query(draft));
    const rs = await Promise.all([press(), press()]);
    expect(createNotice).toHaveBeenCalledTimes(1);
    expect(rs.map((r) => r.answerCallback?.text).sort()).toEqual(["Already posted.", "Posted."]);
  });

  it("Cancel discards the draft", async () => {
    const { ctx } = await setup("ops");
    const r = await onAdminCallback(
      ctx,
      { action: "nw", args: ["x"] },
      query("New notice\nHi\n\nWhere: …\nFor: …\nSeverity: …\nSend to: …"),
    );
    expect(r.edit).toMatchObject({ html: "Notice discarded." });
  });
});

describe("phone buttons", () => {
  const cb = (action: Callback["action"], ...args: string[]): Callback => ({ action, args });

  it("Nudge goes through the service as the person, on telegram", async () => {
    const { ws, ctx } = await setup("ops");
    const phone = await makeDevice(db(), ws.id);
    const r = await onAdminCallback(ctx, cb("nudge", phone.id), query("alert"));
    expect(vi.mocked(nudgePhone).mock.calls[0][2]).toEqual({ workspaceId: ws.id, deviceId: phone.id });
    expect(actorArg(nudgePhone)).toMatchObject({ kind: "admin", channel: "telegram", workspaceId: ws.id });
    expect(r.answerCallback?.text).toContain("Nudged Ravi's phone");
    expect(r.edit).toBeUndefined();
  });

  it("someone else's phone, or one that's gone, never reaches a service", async () => {
    const { ctx } = await setup("admin");
    const other = await makeWorkspace(db());
    const phone = await makeDevice(db(), other.id);
    const r = await onAdminCallback(ctx, cb("nudge", phone.id), query("alert"));
    expect(r.answerCallback).toMatchObject({ text: "You're not a member of this workspace.", showAlert: true });
    expect((await onAdminCallback(ctx, cb("sil1h", "not-a-uuid"), query())).answerCallback?.text).toContain(
      "no longer exists",
    );
    expect(nudgePhone).not.toHaveBeenCalled();
    expect(silencePhone).not.toHaveBeenCalled();
  });

  it("Silence 1h, and a repeat press while silenced is a no-op", async () => {
    const { ws, ctx } = await setup("ops");
    const phone = await makeDevice(db(), ws.id);
    const r = await onAdminCallback(ctx, cb("sil1h", phone.id), query("alert"));
    expect(vi.mocked(silencePhone).mock.calls[0][2]).toEqual({
      workspaceId: ws.id,
      deviceId: phone.id,
      until: new Date(+NOW + H).toISOString(),
    });
    expect(r.answerCallback?.text).toContain("until 11:00");

    await makeSilence(db(), ws.id, phone.id, new Date(+NOW - 60_000), new Date(+NOW + H - 30_000));
    const again = await onAdminCallback(ctx, cb("sil1h", phone.id), query("alert"));
    expect(again.answerCallback?.text).toBe("Already silenced until 10:59.");
    expect(silencePhone).toHaveBeenCalledTimes(1);
  });

  it("two Silence 1h presses at once silence once", async () => {
    const { ws, ctx } = await setup("ops");
    const phone = await makeDevice(db(), ws.id);
    vi.mocked(silencePhone).mockImplementation(async (d, _a, i) => {
      await new Promise((r) => setTimeout(r, 50));
      await makeSilence(d, ws.id, i.deviceId, NOW, new Date(i.until));
      return undefined as never;
    });
    lineUp();
    await Promise.all([1, 2].map(() => onAdminCallback(ctx, cb("sil1h", phone.id), query("alert"))));
    expect(silencePhone).toHaveBeenCalledTimes(1);
  });

  it("Kill asks first (admin only); only the confirm kills, and only once", async () => {
    const ops = await setup("ops");
    const opsPhone = await makeDevice(db(), ops.ws.id);
    const refused = await onAdminCallback(ops.ctx, cb("kill", opsPhone.id), query("alert"));
    expect(refused.answerCallback).toMatchObject({ text: "This needs the admin role.", showAlert: true });
    expect(refused.edit).toBeUndefined();

    const { ws, ctx } = await setup("admin");
    const phone = await makeDevice(db(), ws.id);
    const ask = await onAdminCallback(ctx, cb("kill", phone.id), query("alert"));
    expect(ask.edit?.html).toContain("Kill Ravi's phone?");
    expect(datas(ask.edit?.buttons)).toEqual([`killok:${phone.id}`, "noop"]);
    expect(killPhone).not.toHaveBeenCalled();

    const ok = await onAdminCallback(ctx, cb("killok", phone.id), query(plain(ask.edit?.html ?? "")));
    expect(vi.mocked(killPhone).mock.calls[0][2]).toEqual({ workspaceId: ws.id, deviceId: phone.id });
    expect(ok.edit?.html).toContain("is killed");
    expect(ok.edit?.buttons ?? []).toEqual([]);

    const killed = await makeDevice(db(), ws.id, { killedAt: new Date(+NOW - 60_000) });
    const twice = await onAdminCallback(ctx, cb("killok", killed.id), query("x"));
    expect(twice.answerCallback?.text).toBe("Already killed.");
    expect(twice.edit?.html).toContain("is killed");
    expect(killPhone).toHaveBeenCalledTimes(1);
    expect((await onAdminCallback(ctx, cb("kill", killed.id), query("x"))).edit).toBeUndefined();
  });

  it("Cancel on a confirm changes nothing", async () => {
    const { ctx } = await setup("admin");
    const r = await onAdminCallback(ctx, cb("noop"), query("Kill it?"));
    expect(r.edit).toEqual({ chatId: 42, messageId: 7, html: "OK, nothing changed.", buttons: [] });
    expect((await onAdminCallback(ctx, cb("noop"), { id: "q2", from: { id: 1 } })).edit).toBeUndefined();
  });
});

describe("cancel-a-day buttons", () => {
  it("asks first, then cancels the day once (a repeat CONFLICT still reads as done)", async () => {
    const { ws, ctx } = await setup("ops");
    const svc = await makeService(db(), ws.id, "Riva ↔ Circle");
    const ask = await onAdminCallback(ctx, { action: "cday", args: [svc.id, "20261012"] }, query("today"));
    expect(ask.edit?.html).toContain("Cancel Riva ↔ Circle on Mon 12 Oct?");
    expect(datas(ask.edit?.buttons)).toEqual([`cdayok:${svc.id}:20261012`, "noop"]);
    expect(addException).not.toHaveBeenCalled();

    const ok = await onAdminCallback(ctx, { action: "cdayok", args: [svc.id, "20261012"] }, query("?"));
    expect(vi.mocked(addException).mock.calls[0][2]).toEqual({
      workspaceId: ws.id,
      serviceId: svc.id,
      date: "2026-10-12",
      type: "cancel_day",
    });
    expect(actorArg(addException)).toMatchObject({ channel: "telegram" });
    expect(ok.edit?.html).toContain("Riva ↔ Circle is cancelled on Mon 12 Oct");

    vi.mocked(addException).mockRejectedValueOnce(new ServiceError("CONFLICT", "Already there."));
    const again = await onAdminCallback(ctx, { action: "cdayok", args: [svc.id, "20261012"] }, query("?"));
    expect(again.edit?.html).toContain("is cancelled");
  });

  it("viewers can't, and bad data is an expired button", async () => {
    const { ws, ctx } = await setup("viewer");
    const svc = await makeService(db(), ws.id);
    const r = await onAdminCallback(ctx, { action: "cday", args: [svc.id, "20261012"] }, query("today"));
    expect(r.answerCallback).toMatchObject({ text: "This needs the ops role.", showAlert: true });
    const bad = await onAdminCallback(ctx, { action: "cdayok", args: [svc.id, "2026-10"] }, query("today"));
    expect(bad.answerCallback?.text).toContain("no longer exists");
    expect(addException).not.toHaveBeenCalled();
  });
});

describe("alertButtons", () => {
  it("Nudge phone · Silence 1h, then Open in admin on our own origin", () => {
    expect(alertButtons({ slug: "test", page: "phones", deviceId: "d1" })).toEqual([
      [
        { text: "Nudge phone", callbackData: "nudge:d1" },
        { text: "Silence 1h", callbackData: "sil1h:d1" },
      ],
      [{ text: "Open in admin", url: "http://localhost:3000/admin/phones?w=test" }],
    ]);
    expect(alertButtons({ slug: "live", page: "live" })).toEqual([
      [{ text: "Open in admin", url: "http://localhost:3000/admin/live?w=live" }],
    ]);
  });
});
