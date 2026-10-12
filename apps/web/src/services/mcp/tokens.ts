/**
 * svc-mcp: MCP access tokens (SPEC §7a Auth). Personal `shs_` tokens from the admin People/settings page (CLI
 * agents) and OAuth-issued ones (connectors). Both bound to a person, stored as sha256, revocable, listed in
 * admin. Global rows (no workspace): the MCP adapter builds a per-workspace Actor with auth/actor.adminActor.
 */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { McpToken, Person } from "@/db/types";
import type { Actor } from "../kernel";

export const PERSONAL_TOKEN_PREFIX = "shs_";

/** The plaintext token is returned exactly once, here. */
export type IssuedToken = { token: string; row: McpToken };

export const CreateTokenInput = z.object({ name: z.string().trim().min(1).max(100) });

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
  return notImplemented(db, actor, input);
}

/** Called by auth/oauth.exchangeAuthCode. Kind oauth, name = client ?? "OAuth". Audited mcp_token.create. */
export async function issueOAuthToken(
  db: Db,
  input: { personId: string; client: string | null; expiresAt: Date | null },
  now: Date,
): Promise<IssuedToken> {
  return notImplemented(db, input, now);
}

/** The actor's own tokens (revoked last), never the hash. */
export async function listTokens(db: Db, actor: Actor): Promise<McpToken[]> {
  return notImplemented(db, actor);
}

/** Revoke one of the actor's own tokens (another person's → NOT_FOUND). Audited mcp_token.revoke. */
export async function revokeToken(db: Db, actor: Actor, input: { tokenId: string }, now: Date): Promise<McpToken> {
  return notImplemented(db, actor, input, now);
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
  return notImplemented(db, bearer, now);
}
