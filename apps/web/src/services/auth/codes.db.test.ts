import { makePerson } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, loginCodes, people } from "@/db/schema";
import {
  claimLogin,
  createMagicLink,
  finishLogin,
  LOGIN_CODE_TTL_MS,
  MAGIC_LINK_TTL_MS,
  peekLogin,
  startLogin,
} from "./codes";

// ponytail: svc-people's upsertPersonFromTelegram may still be a stub on this branch; fall back to a plain upsert
// only while it throws "not implemented", so the real one is used as soon as it is merged.
vi.mock("@/services/catalog/people", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/services/catalog/people")>();
  const { people: p } = await import("@/db/schema");
  return {
    ...m,
    upsertPersonFromTelegram: async (...args: Parameters<typeof m.upsertPersonFromTelegram>) => {
      try {
        return await m.upsertPersonFromTelegram(...args);
      } catch (e) {
        if (!String(e).includes("not implemented")) throw e;
        const [db, , { telegramId, username = null, firstName = null, lastName = null }] = args;
        const names = { username, firstName, lastName };
        const [row] = await db
          .insert(p)
          .values({ telegramId, ...names })
          .onConflictDoUpdate({ target: p.telegramId, set: names })
          .returning();
        return row;
      }
    },
  };
});

const db = testDb();
const t0 = new Date("2026-10-15T04:30:00Z");
const later = (ms: number) => new Date(t0.getTime() + ms);
let tg = 7_000_000_000;
const tgUser = () => ({ telegramId: tg++ + Math.floor(Math.random() * 1e6), username: "asha", firstName: "Asha" });

beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME ||= "eci_shuttle_test_bot";
});

describe("Telegram deep-link login", () => {
  it("start → claim → poll logs the person in once, audited", async () => {
    const { code, deepLink, expiresAt } = await startLogin(db, t0);
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(deepLink).toBe(`https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${code}`);
    expect(expiresAt).toEqual(later(LOGIN_CODE_TTL_MS));

    expect(await finishLogin(db, code, "poll", later(1000))).toEqual({ status: "pending" });

    const user = tgUser();
    const person = await claimLogin(db, { code, user }, later(2000));
    expect(person).toMatchObject({ telegramId: user.telegramId, firstName: "Asha" });

    const r = await finishLogin(db, code, "poll", later(3000));
    expect(r).toMatchObject({ status: "ok", person: { id: person.id } });
    expect(await db.select().from(loginCodes).where(eq(loginCodes.code, code))).toEqual([]);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "session.login"), eq(auditLog.entityId, person.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity: "person", workspaceId: null, actorId: person.id, actorKind: "admin" });

    expect(await finishLogin(db, code, "poll", later(4000))).toEqual({ status: "expired" });
  });

  it("claim refuses unknown (NOT_FOUND), already claimed and expired (GONE)", async () => {
    await expect(claimLogin(db, { code: "nope-nope-nope-nope-nope", user: tgUser() }, t0)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const a = await startLogin(db, t0);
    await claimLogin(db, { code: a.code, user: tgUser() }, later(1000));
    await expect(claimLogin(db, { code: a.code, user: tgUser() }, later(2000))).rejects.toMatchObject({ code: "GONE" });
    const b = await startLogin(db, t0);
    await expect(claimLogin(db, { code: b.code, user: tgUser() }, later(LOGIN_CODE_TTL_MS))).rejects.toMatchObject({
      code: "GONE",
    });
  });

  it("an unclaimed code expires for the polling browser", async () => {
    const { code } = await startLogin(db, t0);
    expect(await finishLogin(db, code, "poll", later(LOGIN_CODE_TTL_MS + 1))).toEqual({ status: "expired" });
    expect(await finishLogin(db, "unknown-code-xxxxxxxxxx", "poll", t0)).toEqual({ status: "expired" });
  });
});

describe("magic link", () => {
  it("peek never consumes; finish does, once", async () => {
    const person = await makePerson(db, { firstName: "Ravi" });
    const { url, expiresAt } = await createMagicLink(db, person.id, t0);
    expect(expiresAt).toEqual(later(MAGIC_LINK_TTL_MS));
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${process.env.PUBLIC_ORIGIN}/login/magic`);
    const code = u.searchParams.get("code") as string;

    for (let i = 0; i < 2; i++)
      expect(await peekLogin(db, code, "magic", later(1000))).toMatchObject({
        status: "ready",
        person: { id: person.id },
      });
    expect(await finishLogin(db, code, "magic", later(2000))).toMatchObject({
      status: "ok",
      person: { id: person.id },
    });
    expect(await peekLogin(db, code, "magic", later(3000))).toEqual({ status: "expired" });
  });

  it("expires after MAGIC_LINK_TTL_MS", async () => {
    const person = await makePerson(db);
    const code = new URL((await createMagicLink(db, person.id, t0)).url).searchParams.get("code") as string;
    expect(await peekLogin(db, code, "magic", later(MAGIC_LINK_TTL_MS))).toEqual({ status: "expired" });
    expect(await finishLogin(db, code, "magic", later(MAGIC_LINK_TTL_MS))).toEqual({ status: "expired" });
  });

  it("peek: pending for an unclaimed code, expired for unknown; unknown person → NOT_FOUND", async () => {
    const { code } = await startLogin(db, t0);
    expect(await peekLogin(db, code, "poll", t0)).toEqual({ status: "pending" });
    expect(await peekLogin(db, "zzzzzzzzzzzzzzzzzzzzzzzz", "magic", t0)).toEqual({ status: "expired" });
    await expect(createMagicLink(db, "00000000-0000-0000-0000-000000000000", t0)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a claimed deep-link code is refused on the magic path, and a magic code on the poll path", async () => {
    const { code } = await startLogin(db, t0);
    await claimLogin(db, { code, user: tgUser() }, later(1000));
    expect(await peekLogin(db, code, "magic", later(2000))).toEqual({ status: "expired" });
    expect(await finishLogin(db, code, "magic", later(2000))).toEqual({ status: "expired" });
    expect(await finishLogin(db, code, "poll", later(3000))).toMatchObject({ status: "ok" });

    const person = await makePerson(db);
    const magic = new URL((await createMagicLink(db, person.id, t0)).url).searchParams.get("code") as string;
    expect(await finishLogin(db, magic, "poll", later(1000))).toEqual({ status: "expired" });
    expect(await finishLogin(db, magic, "magic", later(2000))).toMatchObject({ status: "ok" });
  });

  it("only one of two concurrent finishes wins", async () => {
    const person = await makePerson(db);
    const code = new URL((await createMagicLink(db, person.id, t0)).url).searchParams.get("code") as string;
    const rs = await Promise.all([finishLogin(db, code, "magic", t0), finishLogin(db, code, "magic", t0)]);
    expect(rs.map((r) => r.status).sort()).toEqual(["expired", "ok"]);
    expect(await db.select().from(people).where(eq(people.id, person.id))).toHaveLength(1);
  });
});
