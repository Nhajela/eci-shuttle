import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/db/schema";
import { listActivity } from "./activity";

const db = () => testDb();

/** Fixture rows written straight to audit_log: this module only reads it. */
async function audit(workspaceId: string | null, over: Partial<typeof auditLog.$inferInsert> = {}) {
  const [r] = await db()
    .insert(auditLog)
    .values({
      workspaceId,
      actorKind: "admin",
      actorId: "p1",
      channel: "web",
      action: "spot.update",
      entity: "spot",
      entityId: "s1",
      ...over,
    })
    .returning();
  return r;
}

describe("listActivity", () => {
  it("lists this workspace's rows newest first, never another workspace's or global rows", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const a = await audit(ws.id);
    const b = await audit(ws.id, { action: "spot.create" });
    await audit(other.id);
    await audit(null, { action: "mcp_token.create", entity: "mcp_token" });

    const page = await listActivity(db(), actor, { workspaceId: ws.id });
    expect(page.rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(page.nextBefore).toBeNull();
  });

  it("filters by entity, entityId (one object's timeline), actor and proposal", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const s1 = await audit(ws.id, { entityId: "s1" });
    const s2 = await audit(ws.id, { entityId: "s2", actorId: "p2" });
    const v = await audit(ws.id, { entity: "vehicle", entityId: "v1", proposalId: "prop-1" });
    const n = await audit(ws.id, { entity: "notice", entityId: "n1", proposalId: "prop-1" });
    const ids = async (q: object) =>
      (await listActivity(db(), actor, { workspaceId: ws.id, ...q })).rows.map((r) => r.id);

    expect(await ids({ entity: "spot" })).toEqual([s2.id, s1.id]);
    expect(await ids({ entity: "spot", entityId: "s1" })).toEqual([s1.id]);
    expect(await ids({ actorId: "p2" })).toEqual([s2.id]);
    expect(await ids({ proposalId: "prop-1" })).toEqual([n.id, v.id]);
  });

  it("filters by since and pages with a cursor", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const old = await audit(ws.id, { at: new Date("2026-10-10T00:00:00Z") });
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await audit(ws.id, { at: new Date("2026-10-12T00:00:00Z") }));

    const recent = await listActivity(db(), actor, { workspaceId: ws.id, since: "2026-10-11T00:00:00+05:30" });
    expect(recent.rows.map((r) => r.id)).not.toContain(old.id);
    expect(recent.rows).toHaveLength(3);

    const p1 = await listActivity(db(), actor, { workspaceId: ws.id, limit: 2 });
    expect(p1.rows.map((r) => r.id)).toEqual([rows[2].id, rows[1].id]);
    expect(p1.nextBefore).toBe(rows[1].id);
    const p2 = await listActivity(db(), actor, { workspaceId: ws.id, limit: 2, before: p1.nextBefore ?? undefined });
    expect(p2.rows.map((r) => r.id)).toEqual([rows[0].id, old.id]);
    expect(p2.nextBefore).toBeNull();
  });

  it("refuses non-members and bad input", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), other.id);
    await expect(listActivity(db(), actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { actor: mine } = await makeAdmin(db(), ws.id);
    await expect(listActivity(db(), mine, { workspaceId: ws.id, limit: 500 })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});
