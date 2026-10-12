/**
 * svc-mcp: two-step writes (SPEC §7a). shuttle_propose → propose (a plain-English summary, warnings and a
 * proposal code, 10 min, bound to the person, carrying the version of every object touched);
 * shuttle_confirm → confirm (all changes in ONE transaction, refused if anything changed since). Also used by
 * learning/insights.acceptSuggestion.
 */
import { randomInt } from "node:crypto";
import { McpChange, type McpChangeKind } from "@eci-shuttle/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { proposals } from "@/db/schema";
import type { Proposal } from "@/db/types";
import { type Actor, parseInput, requireRole, ServiceError } from "../kernel";
import { applyChange, CHANGE_ROLE, changeWarnings, describeChange, loadVersions, versionKeys } from "./changes";

export const PROPOSAL_TTL_MS = 10 * 60_000;

/** The MCP adapter resolves ProposeInput.workspace (a slug) to workspaceId and builds the actor for it. */
export const ProposeServiceInput = z.object({
  workspaceId: z.uuid(),
  changes: z.array(McpChange).min(1).max(50),
  reason: z.string().trim().max(500).optional(),
});

export type ProposalResult = {
  /** proposals.id: short, unguessable, easy to read back, e.g. "P-7K3Q9XWD" */
  code: string;
  /** the lines joined, plus the reason */
  summary: string;
  /** one per change (changes.describeChange) */
  lines: string[];
  warnings: string[];
  expiresAt: Date;
};

/**
 * Checks every change before storing anything: actor holds CHANGE_ROLE[kind] in the workspace (FORBIDDEN),
 * referenced objects exist there (NOT_FOUND via loadVersions). Stores a proposals row (changes, versions of
 * every versionKeys key, summary, reason, client = actor.client, person = actor.id, expires now + 10 min).
 * Nothing else changes and nothing is audited (the confirm is).
 */
export async function propose(
  db: Db,
  actor: Actor,
  input: z.input<typeof ProposeServiceInput>,
  now: Date,
): Promise<ProposalResult> {
  const { workspaceId, changes, reason } = parseInput(ProposeServiceInput, input);
  for (const c of changes) requireRole(actor, workspaceId, CHANGE_ROLE[c.kind]);
  const versions = await loadVersions(db, workspaceId, [...new Set(changes.flatMap(versionKeys))]);
  const lines: string[] = [];
  for (const c of changes) lines.push(await describeChange(db, workspaceId, c));
  const warnings = await changeWarnings(db, workspaceId, changes, now);
  const summary = [...lines.map((l) => `• ${l}`), ...(reason ? [`Reason: ${reason}`] : [])].join("\n");
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const code = newCode();
  // proposal codes are bookkeeping, not audited (CONTRACTS §2 Audit); the confirm is
  await db.insert(proposals).values({
    id: code,
    workspaceId,
    personId: actor.id,
    changes,
    versions,
    summary,
    reason: reason || null,
    client: actor.client ?? null,
    expiresAt,
  });
  return { code, summary, lines, warnings, expiresAt };
}

/** No 0/O/1/I: easy to read back. 8 of 32 = 40 bits, only usable by its owner for 10 min. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newCode = () => `P-${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;

/**
 * For the MCP confirm adapter, which knows only the code: the workspace of the person's own proposal, so it can
 * build the Actor for it. Unknown or someone else's → NOT_FOUND.
 */
export async function proposalWorkspace(db: Db, personId: string, code: string): Promise<string> {
  const p = await findProposal(db, code);
  if (!p || p.personId !== personId) throw new ServiceError("NOT_FOUND", "No such proposal.", { code });
  return p.workspaceId;
}

async function findProposal(db: Db, code: string, forUpdate = false): Promise<Proposal | undefined> {
  const q = db.select().from(proposals).where(eq(proposals.id, code.trim().toUpperCase())).limit(1);
  return (await (forUpdate ? q.for("update") : q))[0];
}

export type ConfirmResult = {
  proposalId: string;
  summary: string;
  results: { kind: McpChangeKind; result: unknown }[];
};

/**
 * One transaction: unknown code → NOT_FOUND; another person's → FORBIDDEN; confirmed or expired → GONE; any
 * stored version no longer current → STALE_VERSION (nothing applied). Then changes.applyChange for each in
 * order with actor {…actor, proposalId: code, reason}, and confirmed_at = now. Every change writes its own
 * audit row carrying the proposal id.
 */
export async function confirm(db: Db, actor: Actor, input: { code: string }, now: Date): Promise<ConfirmResult> {
  const { code } = parseInput(ConfirmCodeInput, input);
  return db.transaction(async (tx) => {
    const p = await findProposal(tx, code, true);
    if (!p) throw new ServiceError("NOT_FOUND", "No such proposal.", { code });
    if (p.personId !== actor.id) throw new ServiceError("FORBIDDEN", "This proposal belongs to someone else.");
    if (p.confirmedAt) throw new ServiceError("GONE", "This proposal was already confirmed.", { code: p.id });
    if (p.expiresAt <= now) throw new ServiceError("GONE", "This proposal expired. Propose it again.", { code: p.id });
    for (const c of p.changes) requireRole(actor, p.workspaceId, CHANGE_ROLE[c.kind]);

    const current = await loadVersions(tx, p.workspaceId, Object.keys(p.versions));
    const stale = Object.keys(p.versions).filter((k) => current[k] !== p.versions[k]);
    if (stale.length)
      throw new ServiceError("STALE_VERSION", "Something changed since this was proposed. Propose it again.", {
        stale,
      });

    const as: Actor = { ...actor, proposalId: p.id, reason: p.reason ?? undefined };
    const results: ConfirmResult["results"] = [];
    for (const c of p.changes) results.push({ kind: c.kind, result: await applyChange(tx, as, p.workspaceId, c, now) });
    await tx.update(proposals).set({ confirmedAt: now }).where(eq(proposals.id, p.id));
    return { proposalId: p.id, summary: p.summary, results };
  });
}

const ConfirmCodeInput = z.object({ code: z.string().trim().min(1).max(40) });
