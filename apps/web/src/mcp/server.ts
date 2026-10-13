/**
 * web-mcp: one McpServer per request (stateless, as eci-events-mcp), built for the person behind the token.
 * Tool groups (reads, propose/confirm, …) live in their own files and are listed in TOOL_GROUPS; each may add a
 * section to the shuttle_initialize answer telling the model when to use its tools.
 */
import { McpServer } from "@modelcontextprotocol/server";
import type { McpContext } from "./context";
import { guideGroup } from "./guide";
import { registerInitialize } from "./initialize";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from "./text";
import { proposeGroup } from "./tools/propose";
import { readGroup } from "./tools/read";

export type ToolGroup = {
  register(server: McpServer, ctx: McpContext): void;
  /** this group's lines under "## Tools" in shuttle_initialize, or null when this person can't use it */
  section?(ctx: McpContext): string | null;
};

/** Add a group here (one import + one entry) to put its tools on the server. */
export const TOOL_GROUPS: ToolGroup[] = [guideGroup, readGroup, proposeGroup];

export function buildServer(ctx: McpContext, groups: ToolGroup[] = TOOL_GROUPS): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerInitialize(server, ctx, groups);
  for (const g of groups) g.register(server, ctx);
  return server;
}
