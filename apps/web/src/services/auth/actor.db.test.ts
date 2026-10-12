import { makePerson, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { memberships, workspaces } from "@/db/schema";
import { adminActor, attendeeActor, resolveWorkspace } from "./actor";

const db = testDb();

describe("adminActor", () => {
  it("takes the role from the membership and copies channel/client/reason", async () => {
    const ws = await makeWorkspace(db);
    const p = await makePerson(db, { firstName: "Meera", username: "meera" });
    await db.insert(memberships).values({ personId: p.id, workspaceId: ws.id, role: "ops" });
    const a = await adminActor(db, {
      personId: p.id,
      workspaceId: ws.id,
      channel: "mcp",
      client: "claude.ai",
      reason: "r",
    });
    expect(a).toEqual({
      kind: "admin",
      id: p.id,
      workspaceId: ws.id,
      role: "ops",
      channel: "mcp",
      client: "claude.ai",
      reason: "r",
      label: "Meera",
    });
  });

  it("labels by @username without a first name; no membership → FORBIDDEN", async () => {
    const ws = await makeWorkspace(db);
    const p = await makePerson(db, { firstName: null, username: "zed" });
    await expect(adminActor(db, { personId: p.id, workspaceId: ws.id, channel: "web" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db.insert(memberships).values({ personId: p.id, workspaceId: ws.id, role: "viewer" });
    expect((await adminActor(db, { personId: p.id, workspaceId: ws.id, channel: "web" })).label).toBe("@zed");
  });
});

it("attendeeActor has no role and speaks for the bot's workspace", async () => {
  const p = await makePerson(db, { firstName: "Ana" });
  expect(attendeeActor(p, "w1")).toEqual({
    kind: "attendee",
    id: p.id,
    workspaceId: "w1",
    channel: "telegram",
    label: "Ana",
  });
});

describe("resolveWorkspace", () => {
  it("slug if a member → live → first by name; null without memberships", async () => {
    const p = await makePerson(db);
    expect(await resolveWorkspace(db, p.id)).toBeNull();

    const b = await makeWorkspace(db, { name: `B ${Math.random()}` });
    const a = await makeWorkspace(db, { name: `A ${Math.random()}` });
    const outsider = await makeWorkspace(db);
    await db.insert(memberships).values([
      { personId: p.id, workspaceId: a.id, role: "viewer" },
      { personId: p.id, workspaceId: b.id, role: "admin" },
    ]);
    expect(await resolveWorkspace(db, p.id)).toMatchObject({ workspace: { id: a.id }, role: "viewer" });
    expect(await resolveWorkspace(db, p.id, b.slug)).toMatchObject({ workspace: { id: b.id }, role: "admin" });
    expect(await resolveWorkspace(db, p.id, outsider.slug)).toMatchObject({ workspace: { id: a.id } });

    // the one live workspace is global: borrow the flag for this test only
    const [prevLive] = await db.select().from(workspaces).where(eq(workspaces.isLive, true));
    if (prevLive) await db.update(workspaces).set({ isLive: false }).where(eq(workspaces.id, prevLive.id));
    await db.update(workspaces).set({ isLive: true }).where(eq(workspaces.id, b.id));
    try {
      expect(await resolveWorkspace(db, p.id, null)).toMatchObject({ workspace: { id: b.id } });
    } finally {
      await db.update(workspaces).set({ isLive: false }).where(eq(workspaces.id, b.id));
      if (prevLive) await db.update(workspaces).set({ isLive: true }).where(eq(workspaces.id, prevLive.id));
    }
  });
});
