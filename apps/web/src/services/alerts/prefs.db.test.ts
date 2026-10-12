import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "@/db/schema";
import { DEFAULT_ALERT_KINDS, getAlertPrefs, setAlertPrefs } from "./prefs";

const db = () => testDb();

describe("alert prefs", () => {
  it("defaults before anything is saved", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    expect(await getAlertPrefs(db(), actor, { workspaceId: ws.id })).toEqual({
      kinds: DEFAULT_ALERT_KINDS,
      quietFrom: null,
      quietTo: null,
      version: null,
    });
    expect(DEFAULT_ALERT_KINDS).not.toContain("admin_changes");
  });

  it("set upserts own prefs, bumps version, audits alert_prefs.set", async () => {
    const ws = await makeWorkspace(db());
    const { actor, person } = await makeAdmin(db(), ws.id, "viewer");
    const a = await setAlertPrefs(db(), actor, {
      workspaceId: ws.id,
      kinds: ["silent", "silent", "digest"],
      quietFrom: "22:00",
      quietTo: "07:00",
    });
    expect(a).toMatchObject({ personId: person.id, kinds: ["silent", "digest"], version: 1 });
    const b = await setAlertPrefs(db(), actor, {
      workspaceId: ws.id,
      kinds: ["admin_changes"],
      quietFrom: null,
      quietTo: null,
      version: 1,
    });
    expect(b).toMatchObject({ id: a.id, kinds: ["admin_changes"], quietFrom: null, version: 2 });
    expect(await getAlertPrefs(db(), actor, { workspaceId: ws.id })).toEqual({
      kinds: ["admin_changes"],
      quietFrom: null,
      quietTo: null,
      version: 2,
    });
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "alert_prefs.set")));
    expect(audits).toHaveLength(2);
    expect(audits[1].after).toMatchObject({ kinds: ["admin_changes"], version: 2 });
  });

  it("stale version → STALE_VERSION", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    const input = { workspaceId: ws.id, kinds: ["silent" as const], quietFrom: null, quietTo: null };
    await setAlertPrefs(db(), actor, input);
    await setAlertPrefs(db(), actor, { ...input, version: 1 });
    await expect(setAlertPrefs(db(), actor, { ...input, version: 1 })).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
  });

  it("validates quiet hours as a pair", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id);
    await expect(
      setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: [], quietFrom: "22:00", quietTo: null }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("another workspace's member is refused", async () => {
    const ws = await makeWorkspace(db());
    const other = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), other.id);
    await expect(getAlertPrefs(db(), actor, { workspaceId: ws.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setAlertPrefs(db(), actor, { workspaceId: ws.id, kinds: [], quietFrom: null, quietTo: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
