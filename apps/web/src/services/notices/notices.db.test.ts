import { randomUUID } from "node:crypto";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, notices, outbox, routes, services, spots, subscriptions } from "@/db/schema";
import {
  activeNotices,
  createNotice,
  endNotice,
  listNotices,
  recordGroupPost,
  runNoticeLifecycle,
  updateNotice,
} from "./notices";

const db = () => testDb();
const H = 3_600_000;
const iso = (d: Date) => d.toISOString();

async function setup(role: "admin" | "ops" | "viewer" = "ops", over: { groupChatId?: number } = {}) {
  const ws = await makeWorkspace(db(), over);
  const { actor, person } = await makeAdmin(db(), ws.id, role);
  return { ws, actor, person };
}

async function makeSpot(workspaceId: string, name = "Riva") {
  const [s] = await db().insert(spots).values({ workspaceId, name, shortName: name, lat: 15.6, lng: 73.7 }).returning();
  return s;
}

async function makeService(workspaceId: string) {
  const s = await makeSpot(workspaceId);
  const [r] = await db().insert(routes).values({ workspaceId, name: "Loop", spotIds: [s.id] }).returning();
  const [svc] = await db()
    .insert(services)
    .values({
      workspaceId,
      name: "Party",
      kind: "special",
      routeId: r.id,
      validFrom: "2026-10-11",
      validTo: "2026-11-01",
      daysOfWeek: [6],
      startTime: "22:00",
      endTime: "02:00",
      pattern: { kind: "every", everyMin: 20 },
    })
    .returning();
  return svc;
}

/** Insert directly (bypassing the service) to set up times relative to a fixed `now`. */
async function raw(workspaceId: string, over: Partial<typeof notices.$inferInsert> = {}) {
  const [n] = await db()
    .insert(notices)
    .values({ workspaceId, text: "hello", placements: ["everywhere"], ...over })
    .returning();
  return n;
}

describe("createNotice", () => {
  it("creates a notice with defaults, audited as notice.create", async () => {
    const { ws, actor, person } = await setup();
    const n = await createNotice(db(), actor, { workspaceId: ws.id, text: "  Side gate today ", placements: ["everywhere"] });
    expect(n).toMatchObject({
      text: "Side gate today",
      severity: "info",
      pinned: false,
      sort: 0,
      endsAt: null,
      channels: [],
      createdByPersonId: person.id,
    });
    expect(n.startsAt.getTime()).toBeLessThanOrEqual(Date.now());
    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, n.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "notice.create", entity: "notice", workspaceId: ws.id });
  });

  it("needs ops", async () => {
    const { ws, actor } = await setup("viewer");
    await expect(
      createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: ["everywhere"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts spot/service placements from this workspace only", async () => {
    const { ws, actor } = await setup();
    const other = await makeWorkspace(db());
    const spot = await makeSpot(ws.id);
    const svc = await makeService(ws.id);
    const foreign = await makeSpot(other.id);
    const n = await createNotice(db(), actor, {
      workspaceId: ws.id,
      text: "x",
      placements: [`spot:${spot.id}`, `service:${svc.id}`],
    });
    expect(n.placements).toEqual([`spot:${spot.id}`, `service:${svc.id}`]);
    await expect(
      createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: [`spot:${foreign.id}`] }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: [`service:${randomUUID()}`] }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("rejects endsAt not after startsAt, and bad input", async () => {
    const { ws, actor } = await setup();
    const t = new Date(Date.now() + H);
    await expect(
      createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: ["admin"], startsAt: iso(t), endsAt: iso(t) }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: ["admin"], endsAt: iso(new Date(Date.now() - H)) }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(createNotice(db(), actor, { workspaceId: ws.id, text: "x", placements: [] })).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("de-duplicates placements and channels", async () => {
    const { ws, actor } = await setup();
    const n = await createNotice(db(), actor, {
      workspaceId: ws.id,
      text: "x",
      placements: ["admin", "admin"],
      channels: ["group", "group"],
    });
    expect(n.placements).toEqual(["admin"]);
    expect(n.channels).toEqual(["group"]);
  });
});

describe("updateNotice", () => {
  it("edits text/pin/sort/end, bumps version, audits the diff", async () => {
    const { ws, actor } = await setup();
    const n = await createNotice(db(), actor, { workspaceId: ws.id, text: "a", placements: ["everywhere"] });
    const end = new Date(Date.now() + 2 * H);
    const u = await updateNotice(db(), actor, {
      workspaceId: ws.id,
      noticeId: n.id,
      version: n.version,
      text: "b",
      pinned: true,
      sort: 3,
      endsAt: iso(end),
    });
    expect(u).toMatchObject({ text: "b", pinned: true, sort: 3, version: n.version + 1 });
    expect(u.endsAt?.getTime()).toBe(end.getTime());
    const [a] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, n.id), eq(auditLog.action, "notice.update")));
    expect(a.before).toMatchObject({ text: "a", pinned: false });
    expect(a.after).toMatchObject({ text: "b", pinned: true });
  });

  it("refuses a stale version, another workspace's notice, and endsAt before startsAt", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    const n = await createNotice(db(), actor, { workspaceId: ws.id, text: "a", placements: ["everywhere"] });
    await expect(updateNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id, version: 99, text: "b" })).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
    await expect(
      updateNotice(db(), other.actor, { workspaceId: other.ws.id, noticeId: n.id, text: "b" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id, endsAt: iso(new Date(n.startsAt.getTime() - H)) }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("can clear endsAt", async () => {
    const { ws, actor } = await setup();
    const n = await createNotice(db(), actor, {
      workspaceId: ws.id,
      text: "a",
      placements: ["everywhere"],
      endsAt: iso(new Date(Date.now() + H)),
    });
    expect((await updateNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id, endsAt: null })).endsAt).toBeNull();
  });
});

describe("endNotice", () => {
  it("sets endedAt, audited notice.end; ending twice is a conflict", async () => {
    const { ws, actor } = await setup();
    const n = await createNotice(db(), actor, { workspaceId: ws.id, text: "a", placements: ["everywhere"] });
    const e = await endNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id });
    expect(e.endedAt).toBeInstanceOf(Date);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, n.id), eq(auditLog.action, "notice.end")));
    expect(audit).toHaveLength(1);
    await expect(endNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("needs ops", async () => {
    const { ws } = await setup();
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const n = await raw(ws.id);
    await expect(endNotice(db(), actor, { workspaceId: ws.id, noticeId: n.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("activeNotices", () => {
  const now = new Date("2026-10-15T06:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * H);

  it("only started, not ended, not expired notices", async () => {
    const ws = await makeWorkspace(db());
    const live = await raw(ws.id, { text: "live", startsAt: ago(1) });
    const liveWithEnd = await raw(ws.id, { text: "live2", startsAt: ago(1), endsAt: ago(-1) });
    await raw(ws.id, { text: "future", startsAt: ago(-1) });
    await raw(ws.id, { text: "expired", startsAt: ago(2), endsAt: ago(1) });
    await raw(ws.id, { text: "ended", startsAt: ago(2), endedAt: ago(1) });
    const other = await makeWorkspace(db());
    await raw(other.id, { text: "other ws", startsAt: ago(1) });
    const got = await activeNotices(db(), ws.id, now);
    expect(got.map((n) => n.id).sort()).toEqual([live.id, liveWithEnd.id].sort());
  });

  it("filters by placement overlap", async () => {
    const ws = await makeWorkspace(db());
    const spotId = randomUUID();
    const a = await raw(ws.id, { text: "everywhere", startsAt: ago(1), placements: ["everywhere"] });
    const b = await raw(ws.id, { text: "spot", startsAt: ago(1), placements: [`spot:${spotId}`, "schedule"] });
    await raw(ws.id, { text: "admin", startsAt: ago(1), placements: ["admin"] });
    const got = await activeNotices(db(), ws.id, now, ["everywhere", `spot:${spotId}`]);
    expect(got.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect((await activeNotices(db(), ws.id, now, ["schedule"])).map((n) => n.id)).toEqual([b.id]);
    expect(await activeNotices(db(), ws.id, now, [])).toEqual([]);
  });

  it("orders pinned by sort, then severity (urgent first), then newest", async () => {
    const ws = await makeWorkspace(db());
    const add = (text: string, over: Partial<typeof notices.$inferInsert>) => raw(ws.id, { text, ...over });
    await add("info old", { startsAt: ago(3) });
    await add("info new", { startsAt: ago(1) });
    await add("urgent", { startsAt: ago(5), severity: "urgent" });
    await add("heads up", { startsAt: ago(4), severity: "heads_up" });
    await add("pin 2", { startsAt: ago(1), pinned: true, sort: 2 });
    await add("pin 1 info", { startsAt: ago(1), pinned: true, sort: 1 });
    await add("pin 1 urgent", { startsAt: ago(2), pinned: true, sort: 1, severity: "urgent" });
    const got = await activeNotices(db(), ws.id, now);
    expect(got.map((n) => n.text)).toEqual([
      "pin 1 urgent",
      "pin 1 info",
      "pin 2",
      "urgent",
      "heads up",
      "info new",
      "info old",
    ]);
  });
});

describe("listNotices", () => {
  it("current and upcoming first, history (newest first) only on request; viewer+", async () => {
    const { ws, actor } = await setup("viewer");
    const now = Date.now();
    const cur = await raw(ws.id, { text: "current", startsAt: new Date(now - H) });
    const up = await raw(ws.id, { text: "upcoming", startsAt: new Date(now + H) });
    const old = await raw(ws.id, { text: "old", startsAt: new Date(now - 5 * H), endsAt: new Date(now - 4 * H) });
    const ended = await raw(ws.id, { text: "ended", startsAt: new Date(now - 3 * H), endedAt: new Date(now - 2 * H) });
    expect((await listNotices(db(), actor, { workspaceId: ws.id })).map((n) => n.id)).toEqual([cur.id, up.id]);
    expect((await listNotices(db(), actor, { workspaceId: ws.id, includeHistory: true })).map((n) => n.id)).toEqual([
      cur.id,
      up.id,
      ended.id,
      old.id,
    ]);
    const stranger = await setup();
    await expect(listNotices(db(), stranger.actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("runNoticeLifecycle", () => {
  const now = new Date("2026-10-15T06:00:00Z");
  const jobsFor = (workspaceId: string) => db().select().from(outbox).where(eq(outbox.workspaceId, workspaceId));
  const sub = async (workspaceId: string, over: Partial<typeof subscriptions.$inferInsert> = {}) => {
    const p = await makePerson(db());
    await db()
      .insert(subscriptions)
      .values({ workspaceId, personId: p.id, kind: "notices", ...over });
    return p;
  };

  it("sends to subscribers of the placed spot (and all-spot subscribers), posts and pins in the group, once", async () => {
    const ws = await makeWorkspace(db(), { groupChatId: -100123 });
    const riva = await makeSpot(ws.id, "Riva");
    const circle = await makeSpot(ws.id, "Circle");
    const rivaSub = await sub(ws.id, { spotId: riva.id });
    const allSub = await sub(ws.id);
    await sub(ws.id, { spotId: circle.id });
    await sub(ws.id, { spotId: riva.id, cancelledAt: new Date() });
    const blocked = await makePerson(db(), { blockedBotAt: new Date() });
    await db().insert(subscriptions).values({ workspaceId: ws.id, personId: blocked.id, kind: "notices" });
    await sub(ws.id, { kind: "arrival_alert", spotId: riva.id });
    const n = await raw(ws.id, {
      text: "Side gate <today>",
      severity: "urgent",
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date("2026-10-15T08:30:00Z"),
      placements: [`spot:${riva.id}`],
      channels: ["subscribers", "group_pin"],
    });
    await raw(ws.id, { text: "future", startsAt: new Date(now.getTime() + H), channels: ["group"] });
    await raw(ws.id, { text: "no channels", startsAt: new Date(now.getTime() - H) });

    expect(await runNoticeLifecycle(db(), now)).toMatchObject({ sent: 1 });
    const jobs = await jobsFor(ws.id);
    const chats = jobs.map((j) => (j.payload as { chatId: number }).chatId).sort();
    expect(chats).toEqual([rivaSub.telegramId, allSub.telegramId, -100123].sort());
    const group = jobs.find((j) => (j.payload as { chatId: number }).chatId === -100123)?.payload as Record<string, unknown>;
    expect(group).toMatchObject({ pin: true, kind: "notice", ref: { kind: "notice_group_post", noticeId: n.id } });
    expect(group.html).toContain("Side gate &lt;today&gt;");
    expect(group.html).toContain("14:00"); // ends 08:30 UTC = 14:00 IST
    const [after] = await db().select().from(notices).where(eq(notices.id, n.id));
    expect(after.sentAt?.getTime()).toBe(now.getTime());
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, n.id), eq(auditLog.action, "notice.send")));
    expect(audit).toHaveLength(1);

    await runNoticeLifecycle(db(), now);
    expect(await jobsFor(ws.id)).toHaveLength(3);
  });

  it("everywhere goes to every notices subscriber; no group chat means no group post", async () => {
    const ws = await makeWorkspace(db());
    const spot = await makeSpot(ws.id);
    const a = await sub(ws.id, { spotId: spot.id });
    const b = await sub(ws.id);
    await raw(ws.id, { startsAt: new Date(now.getTime() - 1000), channels: ["subscribers", "group"] });
    await runNoticeLifecycle(db(), now);
    const chats = (await jobsFor(ws.id)).map((j) => (j.payload as { chatId: number }).chatId).sort();
    expect(chats).toEqual([a.telegramId, b.telegramId].sort());
  });

  it("does not send notices that already ended", async () => {
    const ws = await makeWorkspace(db(), { groupChatId: -1 });
    await raw(ws.id, { startsAt: new Date(now.getTime() - 2 * H), endsAt: new Date(now.getTime() - H), channels: ["group"] });
    expect(await runNoticeLifecycle(db(), now)).toMatchObject({ sent: 0 });
    expect(await jobsFor(ws.id)).toEqual([]);
  });

  it("unpins a group-pinned notice once it ended or expired, once", async () => {
    const ws = await makeWorkspace(db(), { groupChatId: -100999 });
    const base = { channels: ["group_pin"] as ("group_pin")[], sentAt: new Date(now.getTime() - 2 * H) };
    const expired = await raw(ws.id, { ...base, startsAt: new Date(now.getTime() - 2 * H), endsAt: now, groupMessageId: 41 });
    await raw(ws.id, { ...base, startsAt: new Date(now.getTime() - 2 * H), endsAt: new Date(now.getTime() + H), groupMessageId: 42 });
    await raw(ws.id, { ...base, startsAt: new Date(now.getTime() - 2 * H), endedAt: now, groupMessageId: 43 });
    await raw(ws.id, { ...base, startsAt: new Date(now.getTime() - 2 * H), endedAt: now }); // never posted
    expect(await runNoticeLifecycle(db(), now)).toMatchObject({ unpinned: 2 });
    const unpins = (await jobsFor(ws.id)).map((j) => j.payload as { chatId: number; unpinMessageId: number });
    expect(unpins.map((p) => p.unpinMessageId).sort()).toEqual([41, 43]);
    expect(unpins.every((p) => p.chatId === -100999)).toBe(true);
    const [e] = await db().select().from(notices).where(eq(notices.id, expired.id));
    expect(e.unpinnedAt?.getTime()).toBe(now.getTime());
    expect(await runNoticeLifecycle(db(), now)).toMatchObject({ unpinned: 0 });
  });
});

describe("recordGroupPost", () => {
  it("stores the group message id, audited", async () => {
    const ws = await makeWorkspace(db());
    const n = await raw(ws.id);
    await recordGroupPost(db(), n.id, 777);
    const [after] = await db().select().from(notices).where(eq(notices.id, n.id));
    expect(after.groupMessageId).toBe(777);
    const audit = await db().select().from(auditLog).where(eq(auditLog.entityId, n.id));
    expect(audit.map((a) => a.action)).toEqual(["notice.group_post"]);
    await expect(recordGroupPost(db(), randomUUID(), 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

