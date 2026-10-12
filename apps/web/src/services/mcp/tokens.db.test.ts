import { createHash } from "node:crypto";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, mcpTokens } from "@/db/schema";
import type { Actor } from "../kernel";
import { authenticateMcp, createPersonalToken, issueOAuthToken, listTokens, revokeToken } from "./tokens";

const db = () => testDb();
const NOW = new Date("2026-10-12T04:10:00Z");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function admin() {
  const ws = await makeWorkspace(db());
  return makeAdmin(db(), ws.id, "viewer");
}

describe("createPersonalToken", () => {
  it("returns shs_ + 32 random bytes once, stores only the sha256, audits without the secret", async () => {
    const { person, actor } = await admin();
    const { token, row } = await createPersonalToken(db(), actor, { name: "  laptop  " });
    expect(token).toMatch(/^shs_[A-Za-z0-9_-]{43}$/);
    expect(row).toMatchObject({ personId: person.id, kind: "personal", name: "laptop", prefix: token.slice(0, 8) });
    expect(row).not.toHaveProperty("tokenHash");
    const [stored] = await db().select().from(mcpTokens).where(eq(mcpTokens.id, row.id));
    expect(stored.tokenHash).toBe(sha(token));

    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "mcp_token.create")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: null, actorId: person.id, entity: "mcp_token" });
    const text = JSON.stringify(audits[0]);
    expect(text).not.toContain(token);
    expect(text).not.toContain(stored.tokenHash);
  });

  it("refuses a non-admin actor and an empty name", async () => {
    const device: Actor = { kind: "device", id: "d1", channel: "device" };
    await expect(createPersonalToken(db(), device, { name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { actor } = await admin();
    await expect(createPersonalToken(db(), actor, { name: " " })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("issueOAuthToken", () => {
  it("kind oauth, name = client (or OAuth), expiry stored, audited as the person", async () => {
    const person = await makePerson(db());
    const exp = new Date(NOW.getTime() + 3600_000);
    const a = await issueOAuthToken(db(), { personId: person.id, client: "claude.ai", expiresAt: exp }, NOW);
    expect(a.row).toMatchObject({ kind: "oauth", name: "claude.ai", client: "claude.ai", expiresAt: exp });
    const b = await issueOAuthToken(db(), { personId: person.id, client: null, expiresAt: null }, NOW);
    expect(b.row.name).toBe("OAuth");
    expect(a.token).not.toBe(b.token);
    const audits = await db().select().from(auditLog).where(eq(auditLog.entityId, a.row.id));
    expect(audits).toMatchObject([
      { action: "mcp_token.create", actorId: person.id, channel: "mcp", client: "claude.ai" },
    ]);
  });
});

describe("listTokens / revokeToken", () => {
  it("lists only the actor's own, revoked last, never the hash", async () => {
    const { actor } = await admin();
    const { actor: other } = await admin();
    const t1 = await createPersonalToken(db(), actor, { name: "one" });
    const t2 = await createPersonalToken(db(), actor, { name: "two" });
    await createPersonalToken(db(), other, { name: "theirs" });
    await revokeToken(db(), actor, { tokenId: t1.row.id }, NOW);
    const list = await listTokens(db(), actor);
    expect(list.map((t) => t.name)).toEqual(["two", "one"]);
    expect(list[1].revokedAt).toEqual(NOW);
    for (const t of list) expect(t).not.toHaveProperty("tokenHash");
    expect(t2.row.revokedAt).toBeNull();
  });

  it("revoking another person's token is NOT_FOUND; revoke is audited once", async () => {
    const { actor } = await admin();
    const { actor: other } = await admin();
    const mine = await createPersonalToken(db(), actor, { name: "mine" });
    await expect(revokeToken(db(), other, { tokenId: mine.row.id }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await revokeToken(db(), actor, { tokenId: mine.row.id }, NOW);
    await revokeToken(db(), actor, { tokenId: mine.row.id }, NOW);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, mine.row.id), eq(auditLog.action, "mcp_token.revoke")));
    expect(audits).toHaveLength(1);
  });
});

describe("authenticateMcp", () => {
  it("accepts the token with or without 'Bearer ', returns person and token", async () => {
    const { person, actor } = await admin();
    const { token, row } = await createPersonalToken(db(), actor, { name: "cli" });
    for (const bearer of [token, `Bearer ${token}`, `bearer  ${token} `]) {
      const r = await authenticateMcp(db(), bearer, NOW);
      expect(r.person.id).toBe(person.id);
      expect(r.token.id).toBe(row.id);
    }
  });

  it("UNAUTHENTICATED for missing, unknown, revoked or expired tokens", async () => {
    const { actor, person } = await admin();
    const revoked = await createPersonalToken(db(), actor, { name: "r" });
    await revokeToken(db(), actor, { tokenId: revoked.row.id }, NOW);
    const expired = await issueOAuthToken(db(), { personId: person.id, client: "x", expiresAt: NOW }, NOW);
    for (const bearer of [null, "", "Bearer ", "shs_nope", revoked.token, expired.token]) {
      await expect(authenticateMcp(db(), bearer, NOW)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("sets last_used_at at most once a minute", async () => {
    const { actor } = await admin();
    const { token, row } = await createPersonalToken(db(), actor, { name: "cli" });
    const lastUsed = async () => (await db().select().from(mcpTokens).where(eq(mcpTokens.id, row.id)))[0].lastUsedAt;
    await authenticateMcp(db(), token, NOW);
    expect(await lastUsed()).toEqual(NOW);
    await authenticateMcp(db(), token, new Date(NOW.getTime() + 30_000));
    expect(await lastUsed()).toEqual(NOW);
    const later = new Date(NOW.getTime() + 61_000);
    await authenticateMcp(db(), token, later);
    expect(await lastUsed()).toEqual(later);
  });
});
