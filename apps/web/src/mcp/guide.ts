/** web-mcp: shuttle_guide, depth on one area. The change-kind reference is generated from the frozen McpChange schema. */
import { McpChange } from "@eci-shuttle/shared";
import { z } from "zod";
import { CHANGE_ROLE } from "@/services/mcp/changes";
import { ok, withToolHandler } from "./result";
import type { ToolGroup } from "./server";
import { CHANGE_KINDS_HEADER, GUIDE_SECTION, GUIDE_TOOL, GUIDES, type GuideTopic } from "./text";

/** "- `spot.update` (ops): spotId*, version, name, …" for every change kind. */
export function changeKindsReference(): string {
  const lines = McpChange.options.map((o) => {
    const kind = o.shape.kind.value;
    const fields = Object.entries(o.shape)
      .filter(([k]) => k !== "kind")
      .map(([k, s]) => (s.safeParse(undefined).success ? k : `${k}*`));
    return `- \`${kind}\` (${CHANGE_ROLE[kind]}): ${fields.join(", ") || "no fields"}`;
  });
  return `${CHANGE_KINDS_HEADER}\n${lines.join("\n")}`;
}

export function guideFor(topic: GuideTopic): string {
  return topic === "changes" ? `${GUIDES.changes}\n\n${changeKindsReference()}` : GUIDES[topic];
}

const topics = Object.keys(GUIDES) as [GuideTopic, ...GuideTopic[]];

export const guideGroup: ToolGroup = {
  section: () => GUIDE_SECTION,
  register(server, ctx) {
    server.registerTool(
      GUIDE_TOOL.name,
      {
        title: GUIDE_TOOL.title,
        description: GUIDE_TOOL.description,
        inputSchema: z.object({ topic: z.enum(topics).describe(GUIDE_TOOL.topicArg) }),
        annotations: { readOnlyHint: true },
      },
      withToolHandler(GUIDE_TOOL.name, ctx.person.id, async (p: { topic: GuideTopic }) => ok(guideFor(p.topic))),
    );
  },
};
