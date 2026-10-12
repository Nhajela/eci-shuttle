/**
 * web-mcp: what every tool handler gets for one request. Tokens are global (bound to a person); each tool acts in
 * one workspace through an Actor built for it (auth/actor.adminActor, channel "mcp", client = the connection).
 */
import type { Role } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { McpToken, Person, Workspace } from "@/db/types";
import { adminActor } from "@/services/auth/actor";
import { listMyWorkspaces } from "@/services/catalog/workspaces";
import type { Actor } from "@/services/kernel";
import { ToolError } from "./result";
import { NO_WORKSPACES, PICK_WORKSPACE, UNKNOWN_WORKSPACE, WORKSPACE_ARG } from "./text";

export type McpWorkspace = Workspace & { role: Role };

export type McpContext = {
  db: Db;
  /** the request time: tools pass it to services as `now` */
  now: Date;
  person: Person;
  /** the OAuth client name, else the personal token's name: goes into audit_log.client */
  client: string;
  /** live first, then by name */
  workspaces: McpWorkspace[];
  /** The workspace `slug` names (default: the live one, else the only one) and an Actor acting in it. */
  inWorkspace(slug?: string | null): Promise<{ workspace: McpWorkspace; actor: Actor }>;
};

/** The optional `workspace` argument every workspace tool takes. */
export const workspaceArg = z.string().trim().min(1).max(40).optional().describe(WORKSPACE_ARG);

export async function buildContext(
  db: Db,
  person: Person,
  token: Pick<McpToken, "client" | "name">,
  now: Date,
): Promise<McpContext> {
  const client = token.client ?? token.name;
  const workspaces = await listMyWorkspaces(db, { kind: "admin", id: person.id, channel: "mcp", client });
  const slugs = workspaces.map((w) => w.slug);
  return {
    db,
    now,
    person,
    client,
    workspaces,
    async inWorkspace(slug) {
      const workspace = slug
        ? workspaces.find((w) => w.slug === slug)
        : (workspaces.find((w) => w.isLive) ?? (workspaces.length === 1 ? workspaces[0] : undefined));
      if (!workspaces.length) throw new ToolError(`FORBIDDEN: ${NO_WORKSPACES}`);
      if (!workspace) throw new ToolError(slug ? UNKNOWN_WORKSPACE(slug, slugs) : PICK_WORKSPACE(slugs));
      const actor = await adminActor(db, { personId: person.id, workspaceId: workspace.id, channel: "mcp", client });
      return { workspace, actor };
    },
  };
}
