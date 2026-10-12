import type { McpChange } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { auditLog, proposals, spots } from "@/db/schema";
import { type Actor, getInWorkspace, ServiceError } from "../kernel";
import { confirm, PROPOSAL_TTL_MS, proposalWorkspace, propose } from "./proposals";

// runs inside confirm's transaction just before the changes are applied
const hooks = vi.hoisted(() => ({ beforeApply: null as null | (() => Promise<void>) }));

// changes.ts is svc-mcp's dispatch (another task): fake it over the spots table so propose/confirm are tested alone.
vi.mock("./changes", async (orig) => {
  const { spots } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const k = await import("../kernel");
  return {
    ...(await orig<typeof import("./changes")>()),
    versionKeys: (c: McpChange) => ("spotId" in c ? [`spot:${c.spotId}`] : []),
    loadVersions: async (db: Db, ws: string, keys: string[], opts: { forUpdate?: boolean } = {}) => {
      const out: Record<string, number> = {};
      for (const key of keys) out[key] = (await k.getInWorkspace(db, spots, ws, key.slice(5), "spot", opts)).version;
      return out;
    },
    describeChange: async (_db: Db, _ws: string, c: McpChange) =>
      c.kind === "spot.create" ? `Add spot '${c.name}'` : `Change spot ${"spotId" in c ? c.spotId : "?"}`,
    changeWarnings: async (_db: Db, _ws: string, cs: McpChange[]) =>
      cs.some((c) => c.kind === "spot.archive") ? ["Archiving this leaves a route without a stop"] : [],
    applyChange: async (db: Db, actor: Actor, ws: string, c: McpChange) => {
      await hooks.beforeApply?.();
      if (c.kind === "spot.create")
        return k.mutate(db, actor, { action: "spot.create", entity: "spot", workspaceId: ws }, async (tx) => {
          const [row] = await tx
            .insert(spots)
            .values({ workspaceId: ws, name: c.name, shortName: c.shortName, lat: c.lat, lng: c.lng })
            .returning();
          return { before: null, after: row, result: row };
        });
      if (c.kind === "spot.update")
        return k.mutate(db, actor, { action: "spot.update", entity: "spot", workspaceId: ws }, async (tx) => {
          const before = await k.getInWorkspace(tx, spots, ws, c.spotId, "spot");
          const [after] = await tx
            .update(spots)
            .set({ name: c.name ?? before.name, version: before.version + 1 })
            .where(eq(spots.id, c.spotId))
            .returning();
          return { before, after, result: after };
        });
      throw new k.ServiceError("CONFLICT", "That can't be done.");
    },
  };
});

const db = () => testDb();
const NOW = new Date("2026-10-12T04:50:00Z"); // 10:20 IST

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor, person } = await makeAdmin(db(), ws.id, role, "mcp");
  actor.client = "claude.ai";
  const [spot] = await db()
    .insert(spots)
    .values({ workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 })
    .returning();
  return { ws, actor, person, spot };
}

const create: McpChange = {
  kind: "spot.create",
  name: "Circle",
  shortName: "Circle",
  lat: 15.61,
  lng: 73.71,
} as McpChange;
const rename = (spotId: string, name = "Riva Beach"): McpChange => ({ kind: "spot.update", spotId, name });
const proposalRow = async (code: string) => (await db().select().from(proposals).where(eq(proposals.id, code)))[0];
const auditOf = (ws: string) => db().select().from(auditLog).where(eq(auditLog.workspaceId, ws)).orderBy(auditLog.id);

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ServiceError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("propose", () => {
  it("stores a sealed proposal for several changes: lines, warnings, versions, 10 min, bound to the person", async () => {
    const { ws, actor, person, spot } = await setup();
    const r = await propose(
      db(),
      actor,
      { workspaceId: ws.id, changes: [rename(spot.id), create], reason: "  new signage " },
      NOW,
    );
    expect(r.code).toMatch(/^P-[2-9A-HJ-NP-Z]{8}$/);
    expect(r.lines).toEqual([`Change spot ${spot.id}`, "Add spot 'Circle'"]);
    expect(r.summary).toContain(r.lines[0]);
    expect(r.summary).toContain(r.lines[1]);
    expect(r.summary).toContain("new signage");
    expect(r.warnings).toEqual([]);
    expect(r.expiresAt.getTime()).toBe(NOW.getTime() + PROPOSAL_TTL_MS);

    const row = await proposalRow(r.code);
    expect(row).toMatchObject({
      workspaceId: ws.id,
      personId: person.id,
      versions: { [`spot:${spot.id}`]: 1 },
      reason: "new signage",
      client: "claude.ai",
      summary: r.summary,
      confirmedAt: null,
    });
    expect(row.changes).toHaveLength(2);
    expect(row.expiresAt.getTime()).toBe(r.expiresAt.getTime());
    // nothing else changed, nothing audited
    expect(await auditOf(ws.id)).toEqual([]);
    expect((await getInWorkspace(db(), spots, ws.id, spot.id, "spot")).name).toBe("Riva");
  });

  it("returns the warnings for the whole set", async () => {
    const { ws, actor, spot } = await setup();
    const r = await propose(
      db(),
      actor,
      { workspaceId: ws.id, changes: [{ kind: "spot.archive", spotId: spot.id }] },
      NOW,
    );
    expect(r.warnings).toEqual(["Archiving this leaves a route without a stop"]);
  });

  it("refuses a change above the actor's role and stores nothing", async () => {
    const { ws, actor, spot } = await setup("ops");
    const kill = { kind: "phone.kill", deviceId: crypto.randomUUID() } as McpChange;
    await expectCode(propose(db(), actor, { workspaceId: ws.id, changes: [rename(spot.id), kill] }, NOW), "FORBIDDEN");
    const viewer = await setup("viewer");
    await expectCode(
      propose(db(), viewer.actor, { workspaceId: viewer.ws.id, changes: [rename(viewer.spot.id)] }, NOW),
      "FORBIDDEN",
    );
    expect(await db().select().from(proposals).where(eq(proposals.workspaceId, ws.id))).toEqual([]);
  });

  it("refuses an object from another workspace (NOT_FOUND) and bad input (INVALID)", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    await expectCode(propose(db(), actor, { workspaceId: ws.id, changes: [rename(other.spot.id)] }, NOW), "NOT_FOUND");
    await expectCode(propose(db(), actor, { workspaceId: ws.id, changes: [] }, NOW), "INVALID");
    await expectCode(propose(db(), actor, { workspaceId: other.ws.id, changes: [create] }, NOW), "FORBIDDEN");
    expect(await db().select().from(proposals).where(eq(proposals.workspaceId, ws.id))).toEqual([]);
  });
});

describe("confirm", () => {
  it("applies every change in one go; each audit row carries the proposal id and reason", async () => {
    const { ws, actor, spot } = await setup();
    const p = await propose(
      db(),
      actor,
      { workspaceId: ws.id, changes: [rename(spot.id), create], reason: "signage" },
      NOW,
    );
    const later = new Date(NOW.getTime() + 60_000);
    const r = await confirm(db(), actor, { code: p.code }, later);

    expect(r.proposalId).toBe(p.code);
    expect(r.summary).toBe(p.summary);
    expect(r.results.map((x) => x.kind)).toEqual(["spot.update", "spot.create"]);
    expect((await getInWorkspace(db(), spots, ws.id, spot.id, "spot")).name).toBe("Riva Beach");

    const audit = await auditOf(ws.id);
    expect(audit.map((a) => a.action)).toEqual(["spot.update", "spot.create"]);
    for (const a of audit)
      expect(a).toMatchObject({ proposalId: p.code, reason: "signage", channel: "mcp", client: "claude.ai" });
    expect((await proposalRow(p.code)).confirmedAt?.getTime()).toBe(later.getTime());
  });

  it("refuses with STALE_VERSION when an object changed since the proposal, applying nothing", async () => {
    const { ws, actor, spot } = await setup();
    const p = await propose(db(), actor, { workspaceId: ws.id, changes: [create, rename(spot.id)] }, NOW);
    await db().update(spots).set({ version: 2, name: "Riva (moved)" }).where(eq(spots.id, spot.id));

    await expectCode(confirm(db(), actor, { code: p.code }, NOW), "STALE_VERSION");
    expect(await auditOf(ws.id)).toEqual([]);
    expect(
      await db()
        .select()
        .from(spots)
        .where(and(eq(spots.workspaceId, ws.id), eq(spots.name, "Circle"))),
    ).toEqual([]);
    expect((await proposalRow(p.code)).confirmedAt).toBeNull();
  });

  it("locks the checked objects until it commits, so no one can change them between the check and the apply", async () => {
    const { ws, actor, spot } = await setup();
    const p = await propose(db(), actor, { workspaceId: ws.id, changes: [rename(spot.id)] }, NOW);
    let lockErr: unknown = null;
    hooks.beforeApply = async () => {
      // another connection (another admin) tries to take the row
      lockErr = await db()
        .execute(sql`select id from spots where id = ${spot.id} for update nowait`)
        .then(
          () => "not locked",
          (e: unknown) => e,
        );
    };
    try {
      await confirm(db(), actor, { code: p.code }, NOW);
    } finally {
      hooks.beforeApply = null;
    }
    expect(String((lockErr as { cause?: unknown })?.cause ?? lockErr)).toMatch(/could not obtain lock/);
  });

  it("is one transaction: a failing later change rolls back the earlier ones", async () => {
    const { ws, actor, spot } = await setup("admin");
    const p = await propose(
      db(),
      actor,
      { workspaceId: ws.id, changes: [rename(spot.id), { kind: "notice.end", noticeId: crypto.randomUUID() }] },
      NOW,
    );
    await expectCode(confirm(db(), actor, { code: p.code }, NOW), "CONFLICT");
    expect((await getInWorkspace(db(), spots, ws.id, spot.id, "spot")).name).toBe("Riva");
    expect(await auditOf(ws.id)).toEqual([]);
    expect((await proposalRow(p.code)).confirmedAt).toBeNull();
  });

  it("unknown → NOT_FOUND, someone else's → FORBIDDEN, expired or used → GONE", async () => {
    const { ws, actor, spot } = await setup();
    const p = await propose(db(), actor, { workspaceId: ws.id, changes: [rename(spot.id)] }, NOW);
    await expectCode(confirm(db(), actor, { code: "P-NOPE2345" }, NOW), "NOT_FOUND");
    const { actor: someoneElse } = await makeAdmin(db(), ws.id, "admin", "mcp");
    await expectCode(confirm(db(), someoneElse, { code: p.code }, NOW), "FORBIDDEN");
    await expectCode(confirm(db(), actor, { code: p.code }, new Date(NOW.getTime() + PROPOSAL_TTL_MS)), "GONE");

    await confirm(db(), actor, { code: p.code }, NOW);
    await expectCode(confirm(db(), actor, { code: p.code }, NOW), "GONE");
  });

  it("re-checks roles at confirm time (a demoted person can't confirm)", async () => {
    const { ws, actor, spot } = await setup("ops");
    const p = await propose(db(), actor, { workspaceId: ws.id, changes: [rename(spot.id)] }, NOW);
    await expectCode(confirm(db(), { ...actor, role: "viewer" }, { code: p.code }, NOW), "FORBIDDEN");
  });
});

describe("proposalWorkspace", () => {
  it("the workspace of the person's own proposal; anyone else's or unknown → NOT_FOUND", async () => {
    const { ws, actor, person, spot } = await setup();
    const p = await propose(db(), actor, { workspaceId: ws.id, changes: [rename(spot.id)] }, NOW);
    expect(await proposalWorkspace(db(), person.id, p.code)).toBe(ws.id);
    const { person: other } = await makeAdmin(db(), ws.id);
    await expectCode(proposalWorkspace(db(), other.id, p.code), "NOT_FOUND");
    await expectCode(proposalWorkspace(db(), person.id, "P-UNKNOWN2"), "NOT_FOUND");
  });
});
