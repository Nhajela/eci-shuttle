/**
 * svc-mcp: two-step writes (SPEC §7a). shuttle_propose → propose (a plain-English summary, warnings and a
 * proposal code, 10 min, bound to the person, carrying the version of every object touched);
 * shuttle_confirm → confirm (all changes in ONE transaction, refused if anything changed since). Also used by
 * learning/insights.acceptSuggestion.
 */
import { McpChange, type McpChangeKind, notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Actor } from "../kernel";

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
  return notImplemented(db, actor, input, now);
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
  return notImplemented(db, actor, input, now);
}
