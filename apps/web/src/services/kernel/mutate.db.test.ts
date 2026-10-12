import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, spots, vehicles } from "@/db/schema";
import { systemActor } from "./actor";
import { mutate } from "./mutate";

const db = () => testDb();
const auditFor = (entityId: string) =>
  db().select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);

describe("mutate", () => {
  it("create: runs fn, returns its result, writes one audit row with the whole new row", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const v = await mutate(
      db(),
      actor,
      { action: "vehicle.create", entity: "vehicle", workspaceId: ws.id },
      async (tx) => {
        const [row] = await tx.insert(vehicles).values({ workspaceId: ws.id, name: "Bus 1" }).returning();
        return { before: null, after: row, result: row };
      },
    );
    expect(v.name).toBe("Bus 1");
    const rows = await auditFor(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: ws.id,
      actorKind: "admin",
      actorId: actor.id,
      channel: "web",
      action: "vehicle.create",
      entity: "vehicle",
      entityId: v.id,
      before: null,
    });
    expect(rows[0].after).toMatchObject({ name: "Bus 1", id: v.id, workspaceId: ws.id });
  });

  it("update: stores only the changed fields as before → after, ignoring updatedAt", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "ops");
    const [s] = await db()
      .insert(spots)
      .values({ workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 })
      .returning();
    await mutate(
      db(),
      actor,
      { action: "spot.update", entity: "spot", entityId: s.id, workspaceId: ws.id },
      async (tx) => {
        const [after] = await tx
          .update(spots)
          .set({ radiusM: 120, updatedAt: new Date(Date.now() + 5000), version: sql`${spots.version} + 1` })
          .where(eq(spots.id, s.id))
          .returning();
        return { before: s, after, result: after };
      },
    );
    const [row] = await auditFor(s.id);
    expect(row.before).toEqual({ radiusM: 75, version: 1 });
    expect(row.after).toEqual({ radiusM: 120, version: 2 });
  });

  it("records channel, client, label, reason and proposal id; meta beats actor", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "admin", "mcp");
    const mcpActor = { ...actor, client: "claude.ai", proposalId: "prop-1", reason: "getting fuel" };
    const v = await mutate(
      db(),
      mcpActor,
      { action: "vehicle.create", entity: "vehicle", workspaceId: ws.id },
      async (tx) => {
        const [row] = await tx.insert(vehicles).values({ workspaceId: ws.id, name: "Bus 2" }).returning();
        return { before: null, after: row, result: row };
      },
    );
    const [row] = await auditFor(v.id);
    expect(row).toMatchObject({
      channel: "mcp",
      client: "claude.ai",
      actorLabel: actor.label,
      proposalId: "prop-1",
      reason: "getting fuel",
    });

    const v2 = await mutate(
      db(),
      mcpActor,
      { action: "vehicle.create", entity: "vehicle", workspaceId: ws.id, reason: "override" },
      async (tx) => {
        const [r] = await tx.insert(vehicles).values({ workspaceId: ws.id, name: "Bus 3" }).returning();
        return { before: null, after: r, result: r };
      },
    );
    expect((await auditFor(v2.id))[0].reason).toBe("override");
  });

  it("rolls back the change and the audit row when fn throws", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(
      mutate(db(), actor, { action: "vehicle.create", entity: "vehicle", workspaceId: ws.id }, async (tx) => {
        await tx.insert(vehicles).values({ workspaceId: ws.id, name: "Ghost" });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await db().select().from(vehicles).where(eq(vehicles.workspaceId, ws.id))).toEqual([]);
    expect(await db().select().from(auditLog).where(eq(auditLog.workspaceId, ws.id))).toEqual([]);
  });

  it("nests: two mutations inside one outer transaction both land, or neither does", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const create = (name: string) => async (tx: Parameters<Parameters<typeof mutate>[3]>[0]) => {
      const [row] = await tx.insert(vehicles).values({ workspaceId: ws.id, name }).returning();
      return { before: null, after: row, result: row };
    };
    const meta = { action: "vehicle.create", entity: "vehicle", workspaceId: ws.id };

    await db().transaction(async (tx) => {
      await mutate(tx, actor, meta, create("A"));
      await mutate(tx, actor, meta, create("B"));
    });
    await expect(
      db().transaction(async (tx) => {
        await mutate(tx, actor, meta, create("C"));
        await mutate(tx, actor, meta, async () => {
          throw new Error("second fails");
        });
      }),
    ).rejects.toThrow("second fails");

    const names = (await db().select().from(vehicles).where(eq(vehicles.workspaceId, ws.id))).map((v) => v.name).sort();
    expect(names).toEqual(["A", "B"]);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "vehicle.create")));
    expect(audits).toHaveLength(2);
  });

  it("audits actions with no row change (nudge) and system actors", async () => {
    const ws = await makeWorkspace(db());
    await mutate(
      db(),
      systemActor("watchdog"),
      { action: "phone.nudge", entity: "device", entityId: "dev-1", workspaceId: ws.id },
      async () => ({ before: null, after: null, result: undefined }),
    );
    const [row] = await auditFor("dev-1");
    expect(row).toMatchObject({ actorKind: "system", actorId: "watchdog", channel: "worker", action: "phone.nudge" });
  });

  it("takes entityId and workspaceId from the change when meta can't know them yet (create)", async () => {
    const { actor } = { actor: systemActor("bootstrap") };
    const id = await mutate(
      db(),
      actor,
      { action: "workspace.create", entity: "workspace", workspaceId: null },
      async (tx) => {
        const w = await makeWorkspace(tx);
        return { before: null, after: w, result: w.id, workspaceId: w.id };
      },
    );
    const [row] = await auditFor(id);
    expect(row).toMatchObject({ entityId: id, workspaceId: id });
  });
});
