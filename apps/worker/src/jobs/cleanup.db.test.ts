import { randomUUID } from "node:crypto";
import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, devices, loginCodes, outbox, pairingCodes, pings, proposals } from "@/db/schema";
import { runCleanup } from "./cleanup";

// 03:30 IST on 2 Nov 2026
const NOW = new Date("2026-11-01T22:00:00Z");
const ago = (h: number) => new Date(+NOW - h * 3_600_000);
const code = () => randomUUID().slice(0, 12);

async function makePing(wsId: string) {
  const [d] = await testDb()
    .insert(devices)
    .values({ workspaceId: wsId, label: "Bus", tokenHash: randomUUID() })
    .returning();
  const [p] = await testDb()
    .insert(pings)
    .values({ workspaceId: wsId, deviceId: d.id, recordedAt: ago(48), lat: 15.6, lng: 73.7, accuracy: 5 })
    .returning();
  return p;
}

describe("runCleanup", () => {
  it("deletes login, pairing and proposal codes expired more than a day ago, keeps the rest", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const person = await makePerson(db);
    const [oldLogin, newLogin, oldNoExpiry] = [code(), code(), code()];
    await db.insert(loginCodes).values([
      { code: oldLogin, expiresAt: ago(25) },
      { code: newLogin, expiresAt: ago(23) },
      { code: oldNoExpiry, createdAt: ago(30) },
    ]);
    const [oldPair, newPair] = [code(), code()];
    await db.insert(pairingCodes).values([
      { code: oldPair, workspaceId: ws.id, expiresAt: ago(25), usedAt: ago(30) },
      { code: newPair, workspaceId: ws.id, expiresAt: ago(1) },
    ]);
    const [oldProp, newProp, confirmed] = [code(), code(), code()];
    const prop = { workspaceId: ws.id, personId: person.id, changes: [], versions: {}, summary: "x" };
    await db.insert(proposals).values([
      { ...prop, id: oldProp, expiresAt: ago(25) },
      { ...prop, id: newProp, expiresAt: ago(2) },
      // a confirmed proposal is the record behind its audit rows: never deleted
      { ...prop, id: confirmed, expiresAt: ago(200), confirmedAt: ago(201) },
    ]);

    await runCleanup(db, NOW, undefined);

    const logins = await db
      .select()
      .from(loginCodes)
      .where(inArray(loginCodes.code, [oldLogin, newLogin, oldNoExpiry]));
    expect(logins.map((r) => r.code)).toEqual([newLogin]);
    const pairs = await db
      .select()
      .from(pairingCodes)
      .where(inArray(pairingCodes.code, [oldPair, newPair]));
    expect(pairs.map((r) => r.code)).toEqual([newPair]);
    const props = await db.select().from(proposals).where(eq(proposals.workspaceId, ws.id));
    expect(props.map((r) => r.id).sort()).toEqual([newProp, confirmed].sort());
    // bookkeeping: no audit rows
    expect(await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws.id))).toEqual([]);
  });

  it("deletes outbox rows sent or dead more than 14 days ago, keeps pending and recent ones", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const row = (status: "pending" | "sent" | "dead", createdAt: Date, sentAt: Date | null = null) => ({
      workspaceId: ws.id,
      kind: "telegram" as const,
      payload: {},
      status,
      createdAt,
      sentAt,
      dedupeKey: code(),
    });
    await db
      .insert(outbox)
      .values([
        row("sent", ago(24 * 20), ago(24 * 15)),
        row("dead", ago(24 * 15)),
        row("sent", ago(24 * 20), ago(24 * 13)),
        row("dead", ago(24 * 13)),
        row("pending", ago(24 * 30)),
      ]);

    await runCleanup(db, NOW, undefined);

    const left = await db.select().from(outbox).where(eq(outbox.workspaceId, ws.id));
    expect(left.map((r) => r.status).sort()).toEqual(["dead", "pending", "sent"]);
    expect(left.every((r) => r.status === "pending" || +(r.sentAt ?? r.createdAt) > +ago(24 * 14))).toBe(true);
  });

  it("keeps pings when PINGS_DELETE_AFTER is unset or still in the future (IST)", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const p = await makePing(ws.id);
    await runCleanup(db, NOW, undefined);
    // NOW is 2 Nov in IST but 1 Nov in UTC: the date is read in IST
    await runCleanup(db, NOW, "2026-11-03");
    expect(await db.select().from(pings).where(eq(pings.id, p.id))).toHaveLength(1);
  });

  it("from PINGS_DELETE_AFTER (IST date) on, deletes every ping with one pings.purge audit row", async () => {
    const db = testDb();
    const ws = await makeWorkspace(db);
    const a = await makePing(ws.id);
    const b = await makePing(ws.id);

    const r = await runCleanup(db, NOW, "2026-11-02");

    expect(
      await db
        .select()
        .from(pings)
        .where(inArray(pings.id, [a.id, b.id])),
    ).toEqual([]);
    expect(r.pings).toBeGreaterThanOrEqual(2);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "pings.purge"), eq(auditLog.actorId, "cleanup")));
    const mine = audits.find((x) => x.after?.count === r.pings);
    expect(mine).toMatchObject({ actorKind: "system", entity: "pings", workspaceId: null });

    // nothing left to purge: no empty audit row the next night
    const again = await runCleanup(db, new Date(+NOW + 86_400_000), "2026-11-02");
    expect(again.pings).toBe(0);
    const after = await db.select().from(auditLog).where(eq(auditLog.action, "pings.purge"));
    expect(after).toHaveLength(audits.length);
  });
});
