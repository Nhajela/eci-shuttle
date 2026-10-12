/**
 * web-mcp: the two write tools (SPEC §7a). shuttle_propose → services/mcp/proposals.propose,
 * shuttle_confirm → proposals.confirm. Thin: parse, build the Actor, call, format. Every text a model sees is here.
 */
import { ConfirmInput, istHHMM, ProposeInput } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { type Actor, isServiceError, parseInput, ServiceError } from "@/services/kernel";
import { type ConfirmResult, confirm, type ProposalResult, proposalWorkspace, propose } from "@/services/mcp/proposals";

/** What the MCP route hands each tool call (built from the bearer token's person). */
export type ToolContext = {
  db: Db;
  now: Date;
  personId: string;
  /** auth/actor.adminActor for this person in that workspace, channel "mcp", with the client name */
  actorFor: (workspaceId: string) => Promise<Actor>;
};
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const PROPOSE_DESCRIPTION =
  "Propose one or more changes to a shuttle workspace (spots, routes, services and departures, vehicles, phones, " +
  "pairing codes, notices, workspaces). Nothing changes yet: you get a plain-English summary, warnings and a " +
  "proposal code valid for 10 minutes. Put related changes in one proposal (e.g. cancel a departure and post a " +
  "notice) so they land together. Show the summary and every warning to the person, then call shuttle_confirm " +
  "only after they explicitly say yes.";

export const CONFIRM_DESCRIPTION =
  "Apply a proposal from shuttle_propose, all of its changes at once or none. Only call this after the person " +
  "said yes to that exact summary. Refused if the proposal expired, was already used, or anything it touches " +
  "changed since it was proposed.";

export const proposeText = (r: ProposalResult): string =>
  [
    `Proposal ${r.code} (valid until ${istHHMM(r.expiresAt)} IST). Nothing has changed yet.`,
    "",
    r.summary,
    ...(r.warnings.length ? ["", "Warnings:", ...r.warnings.map((w) => `⚠ ${w}`)] : []),
    "",
    `Show this to the person. Only when they say yes, call shuttle_confirm with code "${r.code}".`,
  ].join("\n");

/** What a result carries that the person needs and the summary can't know: pairing code + QR link, new ids. */
const resultLine = ({ kind, result }: ConfirmResult["results"][number]): string[] => {
  const r = (result ?? {}) as {
    code?: string;
    qrUrl?: string;
    expiresAt?: Date;
    id?: string;
    name?: string;
    title?: string;
  };
  if (kind === "pairing_code.create" && r.code && r.qrUrl && r.expiresAt)
    return [`Pairing code ${r.code}, QR ${r.qrUrl}, valid until ${istHHMM(r.expiresAt)} IST`];
  if (!kind.endsWith(".create") || !r.id) return [];
  const label = r.name ?? r.title;
  return [`New ${kind.split(".")[0]}${label ? ` '${label}'` : ""}: id ${r.id}`];
};

export const confirmText = (r: ConfirmResult): string => {
  const extra = r.results.flatMap(resultLine);
  return [
    `Done (${r.proposalId}). ${r.results.length} change${r.results.length === 1 ? "" : "s"} applied:`,
    r.summary,
    ...(extra.length ? ["", "Give the person:", ...extra] : []),
  ].join("\n");
};

/** Appended to refusals that a fresh proposal fixes. */
export const REPROPOSE_HINT = "Call shuttle_propose again with the current state, and show the person the new summary.";

const errorResult = (e: unknown): ToolResult => {
  if (!isServiceError(e)) throw e;
  const hint = e.code === "STALE_VERSION" || e.code === "GONE" ? ` ${REPROPOSE_HINT}` : "";
  return { content: [{ type: "text", text: `${e.message}${hint}` }], isError: true };
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export async function shuttlePropose(ctx: ToolContext, args: unknown): Promise<ToolResult> {
  try {
    const input = parseInput(ProposeInput, args);
    const ws = await workspaceBySlug(ctx.db, input.workspace);
    if (!ws) throw new ServiceError("NOT_FOUND", `No workspace '${input.workspace}'.`);
    const actor = await ctx.actorFor(ws.id);
    const r = await propose(
      ctx.db,
      actor,
      { workspaceId: ws.id, changes: input.changes, reason: input.reason },
      ctx.now,
    );
    return ok(proposeText(r));
  } catch (e) {
    return errorResult(e);
  }
}

export async function shuttleConfirm(ctx: ToolContext, args: unknown): Promise<ToolResult> {
  try {
    const { code } = parseInput(ConfirmInput, args);
    const actor = await ctx.actorFor(await proposalWorkspace(ctx.db, ctx.personId, code));
    return ok(confirmText(await confirm(ctx.db, actor, { code }, ctx.now)));
  } catch (e) {
    return errorResult(e);
  }
}

/** For the MCP server's tool registry. */
export const proposeTools = [
  { name: "shuttle_propose", description: PROPOSE_DESCRIPTION, inputSchema: ProposeInput, handler: shuttlePropose },
  { name: "shuttle_confirm", description: CONFIRM_DESCRIPTION, inputSchema: ConfirmInput, handler: shuttleConfirm },
] as const;
