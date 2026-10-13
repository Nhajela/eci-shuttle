import { makeSpot } from "@tests/factories/bot-attendee";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, people, workspaces } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { ServiceError } from "../kernel";
import { onAdminCallback, onNotice, onSilence, onStatus, onToday } from "./admin";
import { onAttendeeCallback, onShuttle, onStop } from "./attendee";
import { handleUpdate } from "./handle";
import { onLogin, onStart } from "./start";
import type { BotContext, BotReply, TgUpdate, TgUser } from "./types";

vi.mock("./start", () => ({ onStart: vi.fn(), onLogin: vi.fn() }));
vi.mock("./admin", () => ({
  onStatus: vi.fn(),
  onToday: vi.fn(),
  onSilence: vi.fn(),
  onNotice: vi.fn(),
  onAdminCallback: vi.fn(),
}));
vi.mock("./attendee", () => ({ onShuttle: vi.fn(), onStop: vi.fn(), onAttendeeCallback: vi.fn() }));

const db = () => testDb();
const NOW = new Date("2026-10-12T04:30:00Z");
const OK: BotReply = { send: [{ chatId: 1, html: "ok", kind: "reply" }] };

let live: Workspace;
let seq = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  for (const f of [onStart, onLogin, onStatus, onToday, onSilence, onNotice, onShuttle, onStop])
    vi.mocked(f).mockResolvedValue(OK);
  vi.mocked(onAdminCallback).mockResolvedValue(OK);
  vi.mocked(onAttendeeCallback).mockResolvedValue(OK);
  // one live workspace per database (partial unique index): reuse it if another test file made one
  const [existing] = await db().select().from(workspaces).where(eq(workspaces.isLive, true));
  live = existing ?? (await makeWorkspace(db(), { isLive: true }));
});

const user = (over: Partial<TgUser> = {}): TgUser => ({
  id: 7_000_000_000 + Math.floor(Math.random() * 1e9),
  first_name: "Asha",
  username: `asha${Math.floor(Math.random() * 1e9)}`,
  ...over,
});
const dm = (from: TgUser, text: string): TgUpdate => ({
  update_id: ++seq,
  message: { message_id: 10, date: 0, chat: { id: from.id, type: "private" }, from, text },
});
const inGroup = (from: TgUser, text: string): TgUpdate => ({
  update_id: ++seq,
  message: { message_id: 10, date: 0, chat: { id: -100, type: "supergroup" }, from, text },
});
const ctxOf = (call: unknown[]) => call[0] as BotContext;

describe("handleUpdate", () => {
  it("upserts the sender and routes commands to their handlers with the live workspace", async () => {
    const from = user();
    expect(await handleUpdate(db(), dm(from, "/start abc123"), NOW)).toBe(OK);
    const [p] = await db().select().from(people).where(eq(people.telegramId, from.id));
    expect(p).toMatchObject({ firstName: "Asha", username: from.username });
    const ctx = ctxOf(vi.mocked(onStart).mock.calls[0]);
    expect(ctx).toMatchObject({ chatId: from.id, now: NOW, person: { id: p.id }, workspace: { id: live.id } });
    expect(vi.mocked(onStart).mock.calls[0][1]).toBe("abc123");

    await handleUpdate(db(), dm(from, "/start"), NOW);
    expect(vi.mocked(onStart).mock.calls[1][1]).toBeNull();
    await handleUpdate(db(), dm(from, "/login"), NOW);
    expect(onLogin).toHaveBeenCalledOnce();
    await handleUpdate(db(), dm(from, "/shuttle Riva"), NOW);
    expect(vi.mocked(onShuttle).mock.calls[0][1]).toBe("Riva");
    await handleUpdate(db(), dm(from, "/shuttle"), NOW);
    expect(vi.mocked(onShuttle).mock.calls[1][1]).toBeNull();
    await handleUpdate(db(), dm(from, "/status test"), NOW);
    expect(vi.mocked(onStatus).mock.calls[0][1]).toEqual(["test"]);
    await handleUpdate(db(), dm(from, "/today"), NOW);
    expect(vi.mocked(onToday).mock.calls[0][1]).toEqual([]);
    await handleUpdate(db(), dm(from, "/silence Bus 1  16:00"), NOW);
    expect(vi.mocked(onSilence).mock.calls[0][1]).toEqual(["Bus", "1", "16:00"]);
    await handleUpdate(db(), dm(from, "/notice Pickup at the side gate"), NOW);
    expect(vi.mocked(onNotice).mock.calls[0][1]).toBe("/notice Pickup at the side gate");
    await handleUpdate(db(), dm(from, "/stop"), NOW);
    expect(onStop).toHaveBeenCalledOnce();
    // a group command addressed to the bot by name
    await handleUpdate(db(), inGroup(from, "/status@eci_shuttle_bot"), NOW);
    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it("a spot's name typed alone goes to /shuttle; other text gets help in private, nothing in groups", async () => {
    const n = ++seq;
    await makeSpot(db(), live.id, { name: `Riva ${n}`, shortName: `Riva${n}` });
    const from = user();
    await handleUpdate(db(), dm(from, `  riva${n} `), NOW);
    expect(vi.mocked(onShuttle).mock.calls[0][1]).toBe(`riva${n}`);
    await handleUpdate(db(), inGroup(from, `RIVA ${n}`), NOW);
    expect(onShuttle).toHaveBeenCalledTimes(2);

    const help = await handleUpdate(db(), dm(from, "hello?"), NOW);
    expect(help.send[0]).toMatchObject({ chatId: from.id });
    expect(help.send[0].html).toMatch(/\/shuttle/);
    expect(await handleUpdate(db(), dm(from, "/wat"), NOW)).toMatchObject({ send: [{ chatId: from.id }] });
    expect(await handleUpdate(db(), inGroup(from, "hello all"), NOW)).toEqual({ send: [] });
    expect(await handleUpdate(db(), inGroup(from, "/wat"), NOW)).toEqual({ send: [] });
    expect(onShuttle).toHaveBeenCalledTimes(2);
  });

  it("an archived spot or another workspace's spot is not a stop name", async () => {
    const n = ++seq;
    const other = await makeWorkspace(db());
    await makeSpot(db(), other.id, { name: `Elsewhere ${n}`, shortName: `Else${n}` });
    await makeSpot(db(), live.id, { name: `Gone ${n}`, shortName: `Gone${n}`, archivedAt: NOW });
    const from = user();
    await handleUpdate(db(), dm(from, `else${n}`), NOW);
    await handleUpdate(db(), dm(from, `gone${n}`), NOW);
    expect(onShuttle).not.toHaveBeenCalled();
  });

  it("a ServiceError from a command becomes a reply with its message", async () => {
    vi.mocked(onStatus).mockRejectedValue(new ServiceError("FORBIDDEN", "This is for the ops team."));
    const from = user();
    expect(await handleUpdate(db(), dm(from, "/status"), NOW)).toEqual({
      send: [{ chatId: from.id, html: "This is for the ops team.", kind: "reply" }],
    });
    vi.mocked(onStatus).mockRejectedValue(new Error("boom"));
    await expect(handleUpdate(db(), dm(from, "/status"), NOW)).rejects.toThrow("boom");
  });

  it("routes button presses through handleCallback; old buttons expire", async () => {
    const from = user();
    const msg = { message_id: 5, date: 0, chat: { id: from.id, type: "private" as const }, text: "x" };
    const press = (data: string): TgUpdate => ({
      update_id: ++seq,
      callback_query: { id: `q${seq}`, from, message: msg, data },
    });
    await handleUpdate(db(), press("spot:abc"), NOW);
    expect(vi.mocked(onAttendeeCallback).mock.calls[0][1]).toEqual({ action: "spot", args: ["abc"] });
    expect(ctxOf(vi.mocked(onAttendeeCallback).mock.calls[0])).toMatchObject({ chatId: from.id });
    await handleUpdate(db(), press("killok:dev"), NOW);
    expect(vi.mocked(onAdminCallback).mock.calls[0][1]).toEqual({ action: "killok", args: ["dev"] });
    const old = press("bogus:1");
    expect(await handleUpdate(db(), old, NOW)).toEqual({
      send: [],
      answerCallback: { callbackQueryId: old.callback_query?.id, text: "This button has expired" },
    });
    // a refused press answers the button as an alert, never a chat message (a group would see it)
    vi.mocked(onAdminCallback).mockRejectedValue(new ServiceError("FORBIDDEN", "This is for the ops team."));
    const refused = press("killok:dev");
    expect(await handleUpdate(db(), refused, NOW)).toEqual({
      send: [],
      answerCallback: {
        callbackQueryId: refused.callback_query?.id,
        text: "This is for the ops team.",
        showAlert: true,
      },
    });
  });

  it("a person blocking the bot in private is remembered (audited); unblocking clears it", async () => {
    const from = user();
    const p = await makePerson(db(), { telegramId: from.id, firstName: "Asha", username: from.username });
    const kicked: TgUpdate = {
      update_id: ++seq,
      my_chat_member: { chat: { id: from.id, type: "private" }, from, new_chat_member: { status: "kicked" } },
    };
    expect(await handleUpdate(db(), kicked, NOW)).toEqual({ send: [] });
    const [blocked] = await db().select().from(people).where(eq(people.id, p.id));
    expect(blocked.blockedBotAt).toEqual(NOW);
    const audits = await db().select().from(auditLog).where(eq(auditLog.entityId, p.id));
    expect(audits.map((a) => a.action)).toContain("person.blocked_bot");

    await handleUpdate(db(), dm(from, "/shuttle"), NOW);
    const [back] = await db().select().from(people).where(eq(people.id, p.id));
    expect(back.blockedBotAt).toBeNull();
  });

  it("ignores bots, updates without a sender, and messages without text", async () => {
    expect(await handleUpdate(db(), dm(user({ is_bot: true }), "/start x"), NOW)).toEqual({ send: [] });
    expect(await handleUpdate(db(), { update_id: ++seq }, NOW)).toEqual({ send: [] });
    const from = user();
    const photo: TgUpdate = {
      update_id: ++seq,
      message: { message_id: 1, date: 0, chat: { id: from.id, type: "private" }, from },
    };
    expect(await handleUpdate(db(), photo, NOW)).toEqual({ send: [] });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("no live workspace: says so, but /start and /login still work through any workspace", async () => {
    await db().update(workspaces).set({ isLive: false }).where(eq(workspaces.id, live.id));
    try {
      const from = user();
      expect(await handleUpdate(db(), dm(from, "/shuttle"), NOW)).toEqual({
        send: [{ chatId: from.id, html: "The shuttle isn't set up yet.", kind: "reply" }],
      });
      expect(onShuttle).not.toHaveBeenCalled();
      await handleUpdate(db(), dm(from, "/start code"), NOW);
      expect(ctxOf(vi.mocked(onStart).mock.calls[0]).workspace.id).toBeDefined();
    } finally {
      await db().update(workspaces).set({ isLive: true }).where(eq(workspaces.id, live.id));
    }
  });
});
