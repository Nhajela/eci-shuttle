/**
 * svc-mcp: MCP access tokens (SPEC §7a Auth). Personal `shs_` tokens from the admin People/settings page (CLI
 * agents) and OAuth-issued ones (connectors). Both bound to a person, stored as sha256, revocable, listed in
 * admin. Global rows (no workspace): the MCP adapter builds a per-workspace Actor with auth/actor.adminActor.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { mcpTokens, people } from "@/db/schema";
import type { McpToken, Person } from "@/db/types";
import { type Actor, mutate, parseInput, ServiceError } from "../kernel";

export const PERSONAL_TOKEN_PREFIX = "shs_";
/** OAuth-issued access tokens, so a leaked one is recognisable in logs and secret scanners. */
export const OAUTH_TOKEN_PREFIX = "sho_";
const TOUCH_EVERY_MS = 60_000;

/** A token row as anyone outside this file sees it: never the hash. */
export type PublicToken = Omit<McpToken, "tokenHash">;

/** The plaintext token is returned exactly once, here. */
export type IssuedToken = { token: string; row: PublicToken };

export const CreateTokenInput = z.object({ name: z.string().trim().min(1).max(100) });

const { tokenHash: _hash, ...publicColumns } = getTableColumns(mcpTokens);
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

async function insertToken(
  db: Db,
  actor: Actor,
  values: { personId: string; kind: McpToken["kind"]; name: string; client: string | null; expiresAt: Date | null },
): Promise<IssuedToken> {
  const prefix = values.kind === "personal" ? PERSONAL_TOKEN_PREFIX : OAUTH_TOKEN_PREFIX;
  const token = prefix + randomBytes(32).toString("base64url");
  const row = await mutate(
    db,
    actor,
    { action: "mcp_token.create", entity: "mcp_token", workspaceId: null },
    async (tx) => {
      const [r] = await tx
        .insert(mcpTokens)
        .values({ ...values, tokenHash: hashOf(token), prefix: token.slice(0, 8) })
        .returning(publicColumns);
      return { before: null, after: r, result: r };
    },
  );
  return { token, row };
}

/**
 * A person (actor.kind admin, acting on actor.id; any membership will do) creates a personal token:
 * "shs_" + 32 random bytes base64url; prefix = first 8 chars for display. Audited mcp_token.create
 * (workspaceId null; the diff never contains the token or its hash).
 */
export async function createPersonalToken(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreateTokenInput>,
): Promise<IssuedToken> {
  if (actor.kind !== "admin") throw new ServiceError("FORBIDDEN", "Only admins can create MCP tokens.");
  const { name } = parseInput(CreateTokenInput, input);
  return insertToken(db, actor, { personId: actor.id, kind: "personal", name, client: null, expiresAt: null });
}

/** Called by auth/oauth.exchangeAuthCode. Kind oauth, name = client ?? "OAuth". Audited mcp_token.create. */
export async function issueOAuthToken(
  db: Db,
  input: { personId: string; client: string | null; expiresAt: Date | null },
  _now: Date,
): Promise<IssuedToken> {
  const actor: Actor = { kind: "admin", id: input.personId, channel: "mcp", client: input.client ?? undefined };
  return insertToken(db, actor, {
    personId: input.personId,
    kind: "oauth",
    name: input.client ?? "OAuth",
    client: input.client,
    expiresAt: input.expiresAt,
  });
}

/** The actor's own tokens (revoked last), never the hash. */
export async function listTokens(db: Db, actor: Actor): Promise<PublicToken[]> {
  return db
    .select(publicColumns)
    .from(mcpTokens)
    .where(eq(mcpTokens.personId, actor.id))
    .orderBy(sql`${mcpTokens.revokedAt} is not null`, asc(mcpTokens.createdAt));
}

/** Revoke one of the actor's own tokens (another person's → NOT_FOUND). Audited mcp_token.revoke. */
export async function revokeToken(db: Db, actor: Actor, input: { tokenId: string }, now: Date): Promise<PublicToken> {
  const { tokenId } = parseInput(z.object({ tokenId: z.uuid() }), input);
  const [before] = await db
    .select(publicColumns)
    .from(mcpTokens)
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.personId, actor.id)));
  if (!before) throw new ServiceError("NOT_FOUND", "No such token.");
  if (before.revokedAt) return before;
  return mutate(db, actor, { action: "mcp_token.revoke", entity: "mcp_token", workspaceId: null }, async (tx) => {
    const [after] = await tx
      .update(mcpTokens)
      .set({ revokedAt: now })
      .where(eq(mcpTokens.id, tokenId))
      .returning(publicColumns);
    return { before, after, result: after };
  });
}

/**
 * Bearer → the person and token. Unknown, revoked or expired → UNAUTHENTICATED. Sets last_used_at when it is
 * older than a minute (bookkeeping, not audited).
 */
export async function authenticateMcp(
  db: Db,
  bearer: string | null,
  now: Date,
): Promise<{ person: Person; token: McpToken }> {
  const token = (bearer ?? "").trim().replace(/^bearer\s+/i, "");
  const denied = new ServiceError("UNAUTHENTICATED", "Unknown, revoked or expired token.");
  if (!token) throw denied;
  const [hit] = await db
    .select({ token: mcpTokens, person: people })
    .from(mcpTokens)
    .innerJoin(people, eq(people.id, mcpTokens.personId))
    .where(eq(mcpTokens.tokenHash, hashOf(token)));
  if (!hit || hit.token.revokedAt || (hit.token.expiresAt && hit.token.expiresAt <= now)) throw denied;
  if (!hit.token.lastUsedAt || now.getTime() - hit.token.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
    await db.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, hit.token.id));
    hit.token.lastUsedAt = now;
  }
  return hit;
}
