import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, learningExclusions, suggestions } from "@/db/schema";
import { dismissSuggestion, excludeDay, listSuggestions } from "./insights";

const db = () => testDb();

async function suggestion(workspaceId: string, key: string, status: "open" | "dismissed" = "open") {
  const [row] = await db()
    .insert(suggestions)
    .values({
      workspaceId,
      kind: "dwell_mismatch",
      dedupeKey: key,
      summary: key,
      evidence: {},
      proposedChanges: [],
      status,
    })
    .returning();
  return row;
}

describe("suggestions", () => {
  it("lists open first, filters by status, and only inside the actor's workspace", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "viewer");
    const done = await suggestion(ws.id, "a", "dismissed");
    const open = await suggestion(ws.id, "b");
    expect((await listSuggestions(db(), actor, { workspaceId: ws.id })).map((s) => s.id)).toEqual([open.id, done.id]);
    expect((await listSuggestions(db(), actor, { workspaceId: ws.id, status: "open" })).map((s) => s.id)).toEqual([
      open.id,
    ]);
    const other = await makeWorkspace(db());
    await expect(listSuggestions(db(), actor, { workspaceId: other.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("dismisses an open suggestion once (ops+), audited", async () => {
    const ws = await makeWorkspace(db());
    const s = await suggestion(ws.id, "c");
    const { actor: viewer } = await makeAdmin(db(), ws.id, "viewer");
    await expect(dismissSuggestion(db(), viewer, { workspaceId: ws.id, suggestionId: s.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { actor, person } = await makeAdmin(db(), ws.id, "ops");
    const after = await dismissSuggestion(db(), actor, { workspaceId: ws.id, suggestionId: s.id });
    expect(after).toMatchObject({ status: "dismissed", decidedByPersonId: person.id });
    await expect(dismissSuggestion(db(), actor, { workspaceId: ws.id, suggestionId: s.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "suggestion.dismiss")));
    expect(audits).toHaveLength(1);
  });

  it("excludes a day once per workspace/date/service; a repeat updates the reason", async () => {
    const ws = await makeWorkspace(db());
    const { actor } = await makeAdmin(db(), ws.id, "ops");
    await excludeDay(db(), actor, { workspaceId: ws.id, date: "2026-10-14", reason: "road closed" });
    const again = await excludeDay(db(), actor, { workspaceId: ws.id, date: "2026-10-14", reason: "flooding" });
    expect(again).toMatchObject({ date: "2026-10-14", serviceId: null, reason: "flooding" });
    expect(await db().select().from(learningExclusions).where(eq(learningExclusions.workspaceId, ws.id))).toHaveLength(
      1,
    );
    const otherWs = await makeWorkspace(db());
    await expect(
      excludeDay(db(), actor, { workspaceId: ws.id, date: "2026-10-14", serviceId: otherWs.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
