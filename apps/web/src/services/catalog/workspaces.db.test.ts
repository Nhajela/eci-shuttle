import { randomUUID } from "node:crypto";
import { makeAdmin, makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, memberships, workspaces } from "@/db/schema";
import { bumpConfigs } from "@/services/devices/config";
import { type Actor, systemActor } from "../kernel";
import { createWorkspace, listMyWorkspaces, updateWorkspace, workspaceBySlug } from "./workspaces";

// svc-devices owns bumpConfigs; here we only check that we call it, in the caller's transaction
vi.mock("@/services/devices/config", () => ({ bumpConfigs: vi.fn(async () => []) }));

const db = () => testDb();
const slug = () => `w-${randomUUID().slice(0, 8)}`;
const auditFor = (entityId: string) =>
  db().select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);

beforeEach(() => vi.mocked(bumpConfigs).mockClear());

describe("createWorkspace", () => {
  it("an admin creates a non-live workspace, becomes its admin, and it is audited", async () => {
    const home = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), home.id);
    const s = slug();
    const w = await createWorkspace(db(), actor, { slug: s, name: "  Test two " });
    expect(w).toMatchObject({ slug: s, name: "Test two", isLive: false });

    const [m] = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, w.id), eq(memberships.personId, person.id)));
    expect(m.role).toBe("admin");

    const rows = await auditFor(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "workspace.create", entity: "workspace", workspaceId: w.id });
    expect(rows[0].after).toMatchObject({ slug: s, isLive: false });
  });

  it("an admin of another workspace may create one even when acting as ops elsewhere", async () => {
    const a = await makeWorkspace(db());
    const b = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), a.id, "admin");
    await db().insert(memberships).values({ personId: person.id, workspaceId: b.id, role: "ops" });
    const w = await createWorkspace(db(), { ...actor, workspaceId: b.id, role: "ops" }, { slug: slug(), name: "X" });
    expect(w.isLive).toBe(false);
  });

  it("ops/viewer-only people and attendees are refused", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "ops");
    await expect(createWorkspace(db(), actor, { slug: slug(), name: "X" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const p = await makePerson(db());
    const attendee: Actor = { kind: "attendee", id: p.id, channel: "telegram" };
    await expect(createWorkspace(db(), attendee, { slug: slug(), name: "X" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("an admin actor whose membership is not admin in the DB is refused", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    await expect(createWorkspace(db(), { ...actor, role: "admin" }, { slug: slug(), name: "X" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });

  it("system may create one (no membership row)", async () => {
    const w = await createWorkspace(db(), systemActor("seed"), { slug: slug(), name: "Seeded" });
    expect(await db().select().from(memberships).where(eq(memberships.workspaceId, w.id))).toHaveLength(0);
    expect(await auditFor(w.id)).toHaveLength(1);
  });

  it("a taken slug is CONFLICT and writes nothing", async () => {
    const taken = await makeWorkspace(db());
    const before = await db().select().from(auditLog);
    await expect(createWorkspace(db(), systemActor("seed"), { slug: taken.slug, name: "Dup" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await db().select().from(auditLog)).toHaveLength(before.length);
  });

  it.each([
    ["Upper", "UPPER"],
    ["too short", "a"],
    ["leading dash", "-abc"],
    ["space", "ab c"],
    ["too long", `a${"b".repeat(31)}`],
    ["reserved admin", "admin"],
    ["reserved api", "api"],
  ])("rejects an invalid slug (%s) as INVALID", async (_, bad) => {
    await expect(createWorkspace(db(), systemActor("seed"), { slug: bad, name: "X" })).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("rejects an empty name", async () => {
    await expect(createWorkspace(db(), systemActor("seed"), { slug: slug(), name: "   " })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("updateWorkspace", () => {
  it("admin renames: bumps version, audits only the changed fields, no config bump", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const w = await updateWorkspace(db(), actor, { workspaceId: ws.id, version: 1, name: "Renamed" });
    expect(w).toMatchObject({ name: "Renamed", version: 2, slug: ws.slug });
    const [row] = await auditFor(ws.id);
    expect(row).toMatchObject({ action: "workspace.update", workspaceId: ws.id });
    expect(row.before).toEqual({ name: ws.name, version: 1 });
    expect(row.after).toEqual({ name: "Renamed", version: 2 });
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("changing device settings bumps every device config in the workspace", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await updateWorkspace(db(), actor, { workspaceId: ws.id, activeIntervalS: 20 });
    expect(bumpConfigs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bumpConfigs).mock.calls[0][1]).toEqual({ workspaceId: ws.id });
  });

  it("setting a device field to its current value does not bump", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await updateWorkspace(db(), actor, { workspaceId: ws.id, activeIntervalS: ws.activeIntervalS, name: "N" });
    expect(bumpConfigs).not.toHaveBeenCalled();
  });

  it("ops is refused; another workspace's admin is refused", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor: ops } = await makeAdmin(db(), ws.id, "ops");
    const { actor: stranger } = await makeAdmin(db(), other.id);
    await expect(updateWorkspace(db(), ops, { workspaceId: ws.id, name: "N" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(updateWorkspace(db(), stranger, { workspaceId: ws.id, name: "N" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("stale version is STALE_VERSION; unknown workspace is NOT_FOUND", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(updateWorkspace(db(), actor, { workspaceId: ws.id, version: 7, name: "N" })).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
    await expect(
      updateWorkspace(db(), systemActor("seed"), { workspaceId: randomUUID(), name: "N" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates intervals", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(updateWorkspace(db(), actor, { workspaceId: ws.id, activeIntervalS: 2 })).rejects.toMatchObject({
      code: "INVALID",
    });
  });
});

describe("workspaceBySlug", () => {
  it("null slug → the live workspace; a slug → that workspace; unknown → null", async () => {
    // one live workspace per database (partial unique index): reuse it if another test file made one
    const [existing] = await db().select().from(workspaces).where(eq(workspaces.isLive, true));
    const live = existing ?? (await makeWorkspace(db(), { isLive: true }));
    const test = await makeWorkspace(db());
    expect((await workspaceBySlug(db(), null))?.id).toBe(live.id);
    expect((await workspaceBySlug(db(), test.slug))?.id).toBe(test.id);
    expect(await workspaceBySlug(db(), "nope-nope")).toBeNull();
  });
});

describe("listMyWorkspaces", () => {
  it("lists the person's workspaces with their role there, and nothing for system", async () => {
    const a = await makeWorkspace(db(), { name: "A" });
    const b = await makeWorkspace(db(), { name: "B" });
    await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), a.id, "admin");
    await db().insert(memberships).values({ personId: person.id, workspaceId: b.id, role: "viewer" });
    const list = await listMyWorkspaces(db(), actor);
    expect(list.map((w) => [w.id, w.role])).toEqual([
      [a.id, "admin"],
      [b.id, "viewer"],
    ]);
    expect(await listMyWorkspaces(db(), systemActor("seed"))).toEqual([]);
  });
});
