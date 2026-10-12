import { randomUUID } from "node:crypto";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, memberships, people } from "@/db/schema";
import { type Actor, systemActor } from "../kernel";
import {
  alertRecipients,
  DEFAULT_ALERT_KINDS,
  getAlertPrefs,
  listMembers,
  markBlockedBot,
  membershipsOf,
  setAlertPrefs,
  setRole,
  upsertPersonFromTelegram,
} from "./people";

const db = () => testDb();
const sys = systemActor("auth-bot", "telegram");
const tgId = () => Math.floor(Math.random() * 1e12);
const audits = (entityId: string, action?: string) =>
  db()
    .select()
    .from(auditLog)
    .where(action ? and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)) : eq(auditLog.entityId, entityId));

describe("upsertPersonFromTelegram", () => {
  it("creates a person once, audited person.create with no workspace", async () => {
    const telegramId = tgId();
    const p = await upsertPersonFromTelegram(db(), sys, { telegramId, username: "riya", firstName: "Riya" });
    expect(p).toMatchObject({ telegramId, username: "riya", firstName: "Riya", lastName: null });
    const rows = await audits(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "person.create", entity: "person", workspaceId: null, actorKind: "system" });
  });

  it("refreshes names on a later call without auditing", async () => {
    const telegramId = tgId();
    const a = await upsertPersonFromTelegram(db(), sys, { telegramId, username: "old", firstName: "A" });
    const b = await upsertPersonFromTelegram(db(), sys, { telegramId, username: "new", firstName: "B", lastName: "C" });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ username: "new", firstName: "B", lastName: "C" });
    expect(await audits(a.id)).toHaveLength(1);
  });

  it("leaves names alone when the call omits them", async () => {
    const telegramId = tgId();
    await upsertPersonFromTelegram(db(), sys, { telegramId, username: "keep", firstName: "Keep" });
    const p = await upsertPersonFromTelegram(db(), sys, { telegramId });
    expect(p).toMatchObject({ username: "keep", firstName: "Keep" });
  });

  it("clears blocked_bot_at only when they message the bot again (audited)", async () => {
    const telegramId = tgId();
    const p = await upsertPersonFromTelegram(db(), sys, { telegramId });
    await markBlockedBot(db(), sys, { personId: p.id, at: new Date("2026-10-12T10:00:00Z") });
    const login = await upsertPersonFromTelegram(db(), sys, { telegramId });
    expect(login.blockedBotAt).not.toBeNull();
    const back = await upsertPersonFromTelegram(db(), sys, { telegramId, startedBot: true });
    expect(back.blockedBotAt).toBeNull();
    expect(await audits(p.id, "person.unblocked_bot")).toHaveLength(1);
  });

  it("concurrent first calls create one person", async () => {
    const telegramId = tgId();
    const [a, b] = await Promise.all([
      upsertPersonFromTelegram(db(), sys, { telegramId, firstName: "X" }),
      upsertPersonFromTelegram(db(), sys, { telegramId, firstName: "X" }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await db().select().from(people).where(eq(people.telegramId, telegramId))).toHaveLength(1);
  });

  it("rejects a bad telegram id", async () => {
    await expect(upsertPersonFromTelegram(db(), sys, { telegramId: 1.5 })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("markBlockedBot", () => {
  it("system only, sets blocked_bot_at, audited", async () => {
    const p = await makePerson(db());
    const at = new Date("2026-10-12T10:00:00Z");
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(markBlockedBot(db(), actor, { personId: p.id, at })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await markBlockedBot(db(), sys, { personId: p.id, at });
    const [row] = await db().select().from(people).where(eq(people.id, p.id));
    expect(row.blockedBotAt).toEqual(at);
    expect(await audits(p.id, "person.blocked_bot")).toHaveLength(1);
    // already blocked: no second audit row
    await markBlockedBot(db(), sys, { personId: p.id, at: new Date() });
    expect(await audits(p.id, "person.blocked_bot")).toHaveLength(1);
  });
});

describe("membershipsOf", () => {
  it("returns every membership of a person", async () => {
    const [w1, w2] = [await makeWorkspace(db()), await makeWorkspace(db())];
    const { person } = await makeAdmin(db(), w1.id);
    await db().insert(memberships).values({ personId: person.id, workspaceId: w2.id, role: "viewer" });
    const ms = await membershipsOf(db(), person.id);
    expect(ms.map((m) => [m.workspaceId, m.role]).sort()).toEqual([[w1.id, "admin"], [w2.id, "viewer"]].sort());
  });
});

describe("setRole", () => {
  it("admin adds by username (with or without @, any case), audited membership.set", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const name = `u${randomUUID().slice(0, 8)}`;
    const p = await makePerson(db(), { username: name });
    const m = await setRole(db(), actor, { workspaceId: ws.id, person: { username: `@${name.toUpperCase()}` }, role: "ops" });
    expect(m).toMatchObject({ personId: p.id, workspaceId: ws.id, role: "ops" });
    const rows = await audits(m!.id, "membership.set");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: ws.id, entity: "membership", before: null });
  });

  it("changes a role (bumps version) and removes with null", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const p = await makePerson(db());
    const m1 = await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: "viewer" });
    const m2 = await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: "ops" });
    expect(m2).toMatchObject({ id: m1!.id, role: "ops", version: m1!.version + 1 });
    expect(await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: null })).toBeNull();
    expect(await membershipsOf(db(), p.id)).toEqual([]);
    expect(await audits(m1!.id, "membership.set")).toHaveLength(3);
  });

  it("no-ops are not audited", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const p = await makePerson(db());
    expect(await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: null })).toBeNull();
    const m = await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: "ops" });
    await setRole(db(), actor, { workspaceId: ws.id, person: { personId: p.id }, role: "ops" });
    expect(await audits(m!.id)).toHaveLength(1);
  });

  it("refuses non-admins and admins of another workspace", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor: ops } = await makeAdmin(db(), ws.id, "ops");
    const { actor: foreign } = await makeAdmin(db(), other.id);
    const p = await makePerson(db());
    const input = { workspaceId: ws.id, person: { personId: p.id }, role: "viewer" as const };
    await expect(setRole(db(), ops, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setRole(db(), foreign, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("unknown username or person → NOT_FOUND", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(
      setRole(db(), actor, { workspaceId: ws.id, person: { username: `nobody${randomUUID()}` }, role: "ops" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setRole(db(), actor, { workspaceId: ws.id, person: { personId: randomUUID() }, role: "ops" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to demote or remove the last admin, allows it when another admin exists", async () => {
    const ws = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), ws.id);
    const self = { workspaceId: ws.id, person: { personId: person.id } };
    await expect(setRole(db(), actor, { ...self, role: "ops" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(setRole(db(), actor, { ...self, role: null })).rejects.toMatchObject({ code: "CONFLICT" });
    await makeAdmin(db(), ws.id);
    expect(await setRole(db(), actor, { ...self, role: "ops" })).toMatchObject({ role: "ops" });
  });

  it("two admins demoting each other at once leave one admin", async () => {
    const ws = await makeWorkspace(db());
    const a = await makeAdmin(db(), ws.id);
    const b = await makeAdmin(db(), ws.id);
    const results = await Promise.allSettled([
      setRole(db(), a.actor, { workspaceId: ws.id, person: { personId: b.person.id }, role: "viewer" }),
      setRole(db(), b.actor, { workspaceId: ws.id, person: { personId: a.person.id }, role: "viewer" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const admins = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.role, "admin")));
    expect(admins).toHaveLength(1);
  });

  it("validates input", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(
      setRole(db(), actor, { workspaceId: ws.id, person: { username: "x" }, role: "owner" as never }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("listMembers", () => {
  it("viewer+ sees members with their person rows; outsiders refused", async () => {
    const ws = await makeWorkspace(db());
    const { person: admin } = await makeAdmin(db(), ws.id);
    const { actor: viewer, person: v } = await makeAdmin(db(), ws.id, "viewer");
    const list = await listMembers(db(), viewer, { workspaceId: ws.id });
    expect(list.map((m) => m.person.id).sort()).toEqual([admin.id, v.id].sort());
    expect(list.find((m) => m.personId === admin.id)).toMatchObject({ role: "admin", person: { id: admin.id } });
    const other = await makeWorkspace(db());
    const { actor: foreign } = await makeAdmin(db(), other.id);
    await expect(listMembers(db(), foreign, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("alert prefs", () => {
  it("defaults until set; set is audited and only for your own workspace membership", async () => {
    const ws = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), ws.id, "viewer");
    expect(await getAlertPrefs(db(), actor, { workspaceId: ws.id })).toMatchObject({
      personId: person.id,
      workspaceId: ws.id,
      kinds: DEFAULT_ALERT_KINDS,
      quietFrom: null,
      quietTo: null,
      version: 0,
    });
    const p = await setAlertPrefs(db(), actor, {
      workspaceId: ws.id,
      kinds: ["silent", "digest"],
      quietFrom: "22:00",
      quietTo: "07:00",
    });
    expect(p).toMatchObject({ kinds: ["silent", "digest"], quietFrom: "22:00", quietTo: "07:00", version: 1 });
    const p2 = await setAlertPrefs(db(), actor, { workspaceId: ws.id, version: 1, kinds: [], quietFrom: null, quietTo: null });
    expect(p2).toMatchObject({ id: p.id, kinds: [], quietFrom: null, version: 2 });
    expect(await audits(p.id, "alert_prefs.set")).toHaveLength(2);
    expect(await getAlertPrefs(db(), actor, { workspaceId: ws.id })).toMatchObject({ id: p.id, kinds: [] });
  });

  it("stale version, bad times, half a quiet window and outsiders are refused", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: ["silent"] });
    await expect(
      setAlertPrefs(db(), actor, { workspaceId: ws.id, version: 7, kinds: ["silent"] }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(
      setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: [], quietFrom: "25:00", quietTo: "07:00" }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: [], quietFrom: "22:00" })).rejects.toMatchObject(
      { code: "INVALID" },
    );
    await expect(setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: ["nope" as never] })).rejects.toMatchObject({
      code: "INVALID",
    });
    const other = await makeWorkspace(db());
    await expect(setAlertPrefs(db(), actor, { workspaceId: other.id, kinds: [] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const attendee: Actor = { kind: "attendee", id: actor.id, channel: "telegram" };
    await expect(getAlertPrefs(db(), attendee, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("alertRecipients: members wanting that kind, defaults applied, blocked people skipped", async () => {
    const ws = await makeWorkspace(db());
    const a = await makeAdmin(db(), ws.id); // no prefs: defaults
    const b = await makeAdmin(db(), ws.id, "ops");
    await setAlertPrefs(db(), b.actor, { workspaceId: ws.id, kinds: ["admin_changes"], quietFrom: "22:00", quietTo: "07:00" });
    const c = await makeAdmin(db(), ws.id, "viewer");
    await markBlockedBot(db(), sys, { personId: c.person.id, at: new Date() });
    await makeAdmin(db(), (await makeWorkspace(db())).id); // other workspace

    const silent = await alertRecipients(db(), { workspaceId: ws.id, kind: "silent" });
    expect(silent.map((r) => r.person.id)).toEqual([a.person.id]);
    expect(silent[0]).toMatchObject({ quietFrom: null, quietTo: null, person: { telegramId: a.person.telegramId } });

    const changes = await alertRecipients(db(), { workspaceId: ws.id, kind: "admin_changes" });
    expect(changes.map((r) => r.person.id)).toEqual([b.person.id]);
    expect(changes[0]).toMatchObject({ quietFrom: "22:00", quietTo: "07:00" });
  });
});
