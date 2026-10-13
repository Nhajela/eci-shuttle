import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, routes } from "@/db/schema";
import {
  archiveSpot,
  createSpot,
  isSpotName,
  listSpots,
  overlapWarnings,
  spotOverlapWarnings,
  updateSpot,
} from "./spots";

const db = () => testDb();
const RIVA = { name: "Riva Resort", shortName: "Riva", lat: 15.6705, lng: 73.7135 };
const CIRCLE = { name: "Mandrem Circle", shortName: "Circle", lat: 15.6602, lng: 73.7151 };

async function setup(role: "admin" | "ops" | "viewer" = "ops") {
  const ws = await makeWorkspace(db());
  const { actor } = await makeAdmin(db(), ws.id, role);
  return { ws, actor };
}

const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId));

describe("createSpot", () => {
  it("creates with defaults and writes one spot.create audit row", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    expect(s).toMatchObject({ workspaceId: ws.id, name: "Riva Resort", radiusM: 75, version: 1, archivedAt: null });
    const rows = await audits(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "spot.create", entity: "spot", workspaceId: ws.id, actorId: actor.id });
  });

  it("needs ops: viewer is FORBIDDEN, another workspace's admin is FORBIDDEN", async () => {
    const { ws, actor } = await setup("viewer");
    await expect(createSpot(db(), actor, { workspaceId: ws.id, ...RIVA })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const other = await setup("admin");
    await expect(createSpot(db(), other.actor, { workspaceId: ws.id, ...RIVA })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects invalid input (radius out of range) as INVALID", async () => {
    const { ws, actor } = await setup();
    await expect(createSpot(db(), actor, { workspaceId: ws.id, ...RIVA, radiusM: 5 })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("updateSpot", () => {
  it("changes fields, bumps version, audits only the diff", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    const u = await updateSpot(db(), actor, { workspaceId: ws.id, spotId: s.id, version: 1, radiusM: 120 });
    expect(u).toMatchObject({ radiusM: 120, version: 2, name: "Riva Resort" });
    const rows = (await audits(s.id)).filter((r) => r.action === "spot.update");
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toEqual({ radiusM: 75, version: 1 });
    expect(rows[0].after).toEqual({ radiusM: 120, version: 2 });
  });

  it("STALE_VERSION on a stale version, nothing written", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    await updateSpot(db(), actor, { workspaceId: ws.id, spotId: s.id, name: "Riva 2" });
    await expect(
      updateSpot(db(), actor, { workspaceId: ws.id, spotId: s.id, version: 1, name: "Riva 3" }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await audits(s.id)).filter((r) => r.action === "spot.update")).toHaveLength(1);
  });

  it("NOT_FOUND for a spot of another workspace", async () => {
    const a = await setup();
    const b = await setup();
    const s = await createSpot(db(), a.actor, { workspaceId: a.ws.id, ...RIVA });
    await expect(
      updateSpot(db(), b.actor, { workspaceId: b.ws.id, spotId: s.id, name: "Hijack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("archiveSpot", () => {
  it("sets archivedAt, bumps version, audits spot.archive", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    const a = await archiveSpot(db(), actor, { workspaceId: ws.id, spotId: s.id });
    expect(a.archivedAt).toBeInstanceOf(Date);
    expect(a.version).toBe(2);
    expect((await audits(s.id)).map((r) => r.action)).toContain("spot.archive");
  });

  it("CONFLICT while a non-archived route uses it; allowed once that route is archived", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    const c = await createSpot(db(), actor, { workspaceId: ws.id, ...CIRCLE });
    const [r] = await db()
      .insert(routes)
      .values({ workspaceId: ws.id, name: "Loop", spotIds: [s.id, c.id, s.id] })
      .returning();
    await expect(archiveSpot(db(), actor, { workspaceId: ws.id, spotId: s.id })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { routeIds: [r.id] },
    });
    await db()
      .update(routes)
      .set({ archivedAt: new Date() })
      .where(and(eq(routes.id, r.id)));
    await expect(archiveSpot(db(), actor, { workspaceId: ws.id, spotId: s.id })).resolves.toMatchObject({
      id: s.id,
    });
  });

  it("archiving an already archived spot is CONFLICT", async () => {
    const { ws, actor } = await setup();
    const s = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    await archiveSpot(db(), actor, { workspaceId: ws.id, spotId: s.id });
    await expect(archiveSpot(db(), actor, { workspaceId: ws.id, spotId: s.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("listSpots", () => {
  it("non-archived by name, only this workspace; archived only when asked, after the rest", async () => {
    const { ws, actor } = await setup("admin");
    const other = await setup();
    await createSpot(db(), other.actor, { workspaceId: other.ws.id, ...RIVA, name: "Elsewhere" });
    const r = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    await createSpot(db(), actor, { workspaceId: ws.id, ...CIRCLE });
    await createSpot(db(), actor, { workspaceId: ws.id, ...CIRCLE, name: "Beach" });
    await archiveSpot(db(), actor, { workspaceId: ws.id, spotId: r.id });
    const viewer = (await makeAdmin(db(), ws.id, "viewer")).actor;
    expect((await listSpots(db(), viewer, { workspaceId: ws.id })).map((s) => s.name)).toEqual([
      "Beach",
      "Mandrem Circle",
    ]);
    expect((await listSpots(db(), viewer, { workspaceId: ws.id, includeArchived: true })).map((s) => s.name)).toEqual([
      "Beach",
      "Mandrem Circle",
      "Riva Resort",
    ]);
    await expect(listSpots(db(), other.actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("overlap warning", () => {
  it("pure: warns when geofences overlap (distance < r1 + r2), not when apart", () => {
    const near = { id: "b", name: "Riva Gate", shortName: "Gate", lat: 15.6709, lng: 73.7135, radiusM: 75 };
    const far = { id: "c", ...CIRCLE, radiusM: 75 };
    const w = overlapWarnings({ ...RIVA, radiusM: 75 }, [near, far]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Riva Gate/);
    expect(w[0]).toMatch(/44 m apart/);
    expect(overlapWarnings({ ...RIVA, radiusM: 75 }, [far])).toEqual([]);
  });

  it("pure: ignores the spot itself (excludeId)", () => {
    const self = { id: "a", ...RIVA, radiusM: 75 };
    expect(overlapWarnings({ ...RIVA, radiusM: 75, id: "a" }, [self])).toEqual([]);
  });

  it("db: checks non-archived spots of the same workspace only", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    await createSpot(db(), other.actor, { workspaceId: other.ws.id, ...RIVA, name: "Other ws" });
    const gate = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA, name: "Riva Gate", lat: 15.6709 });
    const old = await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA, name: "Old Riva" });
    await archiveSpot(db(), actor, { workspaceId: ws.id, spotId: old.id });
    const w = await spotOverlapWarnings(db(), actor, { workspaceId: ws.id, ...RIVA, radiusM: 75 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Riva Gate/);
    expect(await spotOverlapWarnings(db(), actor, { workspaceId: ws.id, ...RIVA, spotId: gate.id })).toEqual([]);
  });
});

describe("isSpotName", () => {
  it("matches a non-archived spot's short name or name typed alone, any case, in this workspace only", async () => {
    const { ws, actor } = await setup();
    const other = await setup();
    await createSpot(db(), actor, { workspaceId: ws.id, ...RIVA });
    const old = await createSpot(db(), actor, { workspaceId: ws.id, ...CIRCLE });
    await archiveSpot(db(), actor, { workspaceId: ws.id, spotId: old.id, version: 1 });
    await createSpot(db(), other.actor, { workspaceId: other.ws.id, ...RIVA, name: "Party Venue", shortName: "Party" });
    for (const t of ["riva", " RIVA ", "riva resort", "Riva Resort"])
      expect(await isSpotName(db(), ws.id, t)).toBe(true);
    for (const t of ["circle", "party", "riva please", "", "  ", "%", "riv_"])
      expect(await isSpotName(db(), ws.id, t)).toBe(false);
  });
});
