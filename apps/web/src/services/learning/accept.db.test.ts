import type { McpChange } from "@eci-shuttle/shared";
import { makeAdmin, makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { auditLog, proposals, spots, suggestions } from "@/db/schema";
import { PROPOSAL_TTL_MS } from "../mcp/proposals";
import { acceptSuggestion, listSuggestions } from "./insights";

// changes.ts is svc-mcp's dispatch (another task): fake the read side over the spots table.
vi.mock("@/services/mcp/changes", async (orig) => {
  const k = await import("../kernel");
  const { spots } = await import("@/db/schema");
  return {
    ...(await orig<typeof import("../mcp/changes")>()),
    versionKeys: (c: McpChange) => ("spotId" in c ? [`spot:${c.spotId}`] : []),
    loadVersions: async (db: Db, ws: string, keys: string[]) => {
      const out: Record<string, number> = {};
      for (const key of keys) out[key] = (await k.getInWorkspace(db, spots, ws, key.slice(5), "spot")).version;
      return out;
    },
    describeChange: async () => "Rename spot Riva",
    changeWarnings: async () => [],
  };
});

const db = () => testDb();
const NOW = new Date("2026-10-12T04:50:00Z"); // 10:20 IST

async function setup(role: "ops" | "viewer" = "ops", informational = false) {
  const ws = await makeWorkspace(db());
  const { actor, person } = await makeAdmin(db(), ws.id, role);
  const [spot] = await db()
    .insert(spots)
    .values({ workspaceId: ws.id, name: "Riva", shortName: "Riva", lat: 15.6, lng: 73.7 })
    .returning();
  const change: McpChange = { kind: "spot.update", spotId: spot.id, name: "Riva Beach" };
  const [s] = await db()
    .insert(suggestions)
    .values({
      workspaceId: ws.id,
      kind: "shift_departure",
      dedupeKey: "k",
      summary: "Shift the 09:40 from Riva to 09:50?",
      evidence: {},
      proposedChanges: informational ? [] : [change],
    })
    .returning();
  return { ws, actor, person, spot, s, input: { workspaceId: ws.id, suggestionId: s.id } };
}

const row = async (id: string) => (await db().select().from(suggestions).where(eq(suggestions.id, id)))[0];
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("acceptSuggestion", () => {
  it("turns the proposed changes into a proposal for the actor, records its id, audited; nothing applied", async () => {
    const { ws, actor, person, spot, s, input } = await setup();
    const r = await acceptSuggestion(db(), actor, input, NOW);
    expect(r.proposalCode).toMatch(/^P-[2-9A-HJ-NP-Z]{8}$/);
    expect(r.summary).toBe("• Rename spot Riva\nReason: Shift the 09:40 from Riva to 09:50?");
    expect(r.suggestion).toMatchObject({
      status: "accepted",
      proposalId: r.proposalCode,
      decidedByPersonId: person.id,
      decidedAt: NOW,
    });
    const [p] = await db().select().from(proposals).where(eq(proposals.id, r.proposalCode));
    expect(p).toMatchObject({ personId: person.id, workspaceId: ws.id, expiresAt: later(PROPOSAL_TTL_MS) });
    expect(p.changes).toEqual(s.proposedChanges);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, "suggestion.accept")));
    expect(audits).toHaveLength(1);
    expect((await db().select().from(spots).where(eq(spots.id, spot.id)))[0].name).toBe("Riva");
  });

  it("refuses viewers, other workspaces, informational and dismissed suggestions", async () => {
    const { input } = await setup("viewer");
    const { actor } = await setup();
    await expect(acceptSuggestion(db(), actor, input, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const v = await setup("viewer");
    const { actor: ops } = await makeAdmin(db(), v.ws.id, "ops");
    await expect(acceptSuggestion(db(), v.actor, v.input, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(suggestions).set({ status: "dismissed" }).where(eq(suggestions.id, v.s.id));
    await expect(acceptSuggestion(db(), ops, v.input, NOW)).rejects.toMatchObject({ code: "CONFLICT" });

    const info = await setup("ops", true);
    await expect(acceptSuggestion(db(), info.actor, info.input, NOW)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await row(info.s.id)).toMatchObject({ status: "open", proposalId: null });
    expect(await db().select().from(proposals).where(eq(proposals.workspaceId, info.ws.id))).toHaveLength(0);
  });

  it("refuses a second accept while its proposal is live or once it was confirmed", async () => {
    const { actor, s, input } = await setup();
    const first = await acceptSuggestion(db(), actor, input, NOW);
    await expect(acceptSuggestion(db(), actor, input, later(60_000))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(first.proposalCode),
    });
    await db()
      .update(proposals)
      .set({ confirmedAt: later(1) })
      .where(eq(proposals.id, first.proposalCode));
    await expect(acceptSuggestion(db(), actor, input, later(PROPOSAL_TTL_MS + 1))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await row(s.id)).proposalId).toBe(first.proposalCode);
  });

  it("re-proposes once the earlier proposal expired unconfirmed, or was cleaned up", async () => {
    const { actor, s, input } = await setup();
    const first = await acceptSuggestion(db(), actor, input, NOW);
    const t2 = later(PROPOSAL_TTL_MS);
    const second = await acceptSuggestion(db(), actor, input, t2);
    expect(second.proposalCode).not.toBe(first.proposalCode);
    expect(await row(s.id)).toMatchObject({ status: "accepted", proposalId: second.proposalCode, decidedAt: t2 });

    await db().delete(proposals).where(eq(proposals.id, second.proposalCode));
    const third = await acceptSuggestion(db(), actor, input, later(PROPOSAL_TTL_MS + 5_000));
    expect((await row(s.id)).proposalId).toBe(third.proposalCode);
  });

  it("an accept nobody confirmed shows as open again once its proposal expires; a confirmed one does not", async () => {
    const { actor, s, input, ws } = await setup();
    const openIds = async (at: Date) =>
      (await listSuggestions(db(), actor, { workspaceId: ws.id, status: "open" }, at)).map((x) => x.id);
    const first = await acceptSuggestion(db(), actor, input, NOW);
    expect(await openIds(later(60_000))).toEqual([]);
    expect(await openIds(later(PROPOSAL_TTL_MS))).toEqual([s.id]);
    expect((await listSuggestions(db(), actor, { workspaceId: ws.id }, later(PROPOSAL_TTL_MS)))[0].status).toBe("open");

    const second = await acceptSuggestion(db(), actor, input, later(PROPOSAL_TTL_MS));
    await db()
      .update(proposals)
      .set({ confirmedAt: later(PROPOSAL_TTL_MS + 1) })
      .where(eq(proposals.id, second.proposalCode));
    expect(await openIds(later(3 * PROPOSAL_TTL_MS))).toEqual([]);
    const accepted = await listSuggestions(
      db(),
      actor,
      { workspaceId: ws.id, status: "accepted" },
      later(3 * PROPOSAL_TTL_MS),
    );
    expect(accepted.map((x) => x.id)).toEqual([s.id]);
    expect(first.proposalCode).not.toBe(second.proposalCode);
  });
});
