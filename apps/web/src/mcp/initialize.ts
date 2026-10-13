/**
 * web-mcp: shuttle_initialize (SPEC §7a): who you are, your workspaces and roles, today's snapshot per workspace
 * (vehicles, today's services, open problems, open suggestions), the rules and which tools to use.
 * A snapshot part that fails says so instead of failing the whole answer.
 */
import { formatIst, istDate, istHHMM, type Phase } from "@eci-shuttle/shared";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { detectProblems } from "@/services/alerts/watchdog";
import { getSchedule } from "@/services/catalog/schedule";
import { listVehicles } from "@/services/catalog/vehicles";
import { vehicleStates } from "@/services/ingest/ingest";
import type { Actor } from "@/services/kernel";
import { listSuggestions } from "@/services/learning/insights";
import type { McpContext, McpWorkspace } from "./context";
import { ok, withToolHandler } from "./result";
import type { ToolGroup } from "./server";
import { INITIALIZE_TOOL, NO_WORKSPACES, ROLES_TEXT, RULES, SNAPSHOT_PART_FAILED, TOOLS_HEADER } from "./text";

export const PHASE_TEXT: Record<Phase, string> = {
  at_spot: "at a stop",
  en_route: "on the way",
  offline: "offline",
  off_duty: "off duty",
};
export const SNAPSHOT = {
  vehicles: "Vehicles",
  noVehicles: "Vehicles: none active.",
  lastSeen: "last seen",
  services: "Today's services",
  noServices: "Today's services: none.",
  noDepartures: "no departures (cancelled or outside its days)",
  departures: (n: number, first: string, last: string) => `${n} departure${n === 1 ? "" : "s"}, ${first}–${last}`,
  problems: "Open problems",
  noProblems: "Open problems: none.",
  since: "since",
  suggestions: "Open timetable suggestions",
  moreSuggestions: (n: number) => `…and ${n} more.`,
  live: "LIVE: what attendees see",
  test: "test",
  update: (id: string | null) =>
    `App update for every phone: ${id ? `${id} (phones may override it; see shuttle_phones)` : "none set"}`,
} as const;
const MAX_SUGGESTIONS = 3;

type Part = (ctx: McpContext, ws: McpWorkspace, actor: Actor) => Promise<string>;

const vehiclesPart: Part = async (ctx, ws, actor) => {
  const [vehicles, states] = await Promise.all([
    listVehicles(ctx.db, actor, { workspaceId: ws.id }),
    vehicleStates(ctx.db, ws.id),
  ]);
  const byId = new Map(states.map((s) => [s.vehicleId, s]));
  const active = vehicles.filter((v) => v.active);
  if (!active.length) return SNAPSHOT.noVehicles;
  const lines = active.map((v) => {
    const s = byId.get(v.id);
    const phase = PHASE_TEXT[s?.phase ?? "off_duty"];
    return `- ${v.name}: ${phase}${s?.lastPingAt ? ` (${SNAPSHOT.lastSeen} ${istHHMM(s.lastPingAt)})` : ""}`;
  });
  return `${SNAPSHOT.vehicles}:\n${lines.join("\n")}`;
};

const servicesPart: Part = async (ctx, ws, actor) => {
  const [day] = await getSchedule(ctx.db, actor, { workspaceId: ws.id, from: istDate(ctx.now), days: 1 });
  if (!day?.services.length) return SNAPSHOT.noServices;
  const lines = day.services.map(({ service, departures }) => {
    const times = departures.map((d) => d.at).sort((a, b) => a - b);
    const what = times.length
      ? SNAPSHOT.departures(times.length, istHHMM(times[0]), istHHMM(times[times.length - 1]))
      : SNAPSHOT.noDepartures;
    return `- ${service.name}: ${what}`;
  });
  return `${SNAPSHOT.services}:\n${lines.join("\n")}`;
};

const problemsPart: Part = async (ctx, ws) => {
  const problems = await detectProblems(ctx.db, ws.id, ctx.now);
  if (!problems.length) return SNAPSHOT.noProblems;
  return `${SNAPSHOT.problems}:\n${problems.map((p) => `- ${p.message} (${SNAPSHOT.since} ${istHHMM(p.since)})`).join("\n")}`;
};

const suggestionsPart: Part = async (ctx, ws, actor) => {
  const open = await listSuggestions(ctx.db, actor, { workspaceId: ws.id, status: "open" });
  if (!open.length) return "";
  const shown = open.slice(0, MAX_SUGGESTIONS).map((s) => `- ${s.summary}`);
  if (open.length > MAX_SUGGESTIONS) shown.push(SNAPSHOT.moreSuggestions(open.length - MAX_SUGGESTIONS));
  return `${SNAPSHOT.suggestions}:\n${shown.join("\n")}`;
};

const PARTS: [string, Part][] = [
  [SNAPSHOT.vehicles, vehiclesPart],
  [SNAPSHOT.services, servicesPart],
  [SNAPSHOT.problems, problemsPart],
  [SNAPSHOT.suggestions, suggestionsPart],
];

async function snapshot(ctx: McpContext, ws: McpWorkspace): Promise<string> {
  const head = `## ${ws.name} (\`${ws.slug}\`, ${ws.isLive ? SNAPSHOT.live : SNAPSHOT.test}): you are ${ws.role}\n${SNAPSHOT.update(ws.targetUpdateId)}`;
  let actor: Actor;
  try {
    actor = (await ctx.inWorkspace(ws.slug)).actor;
  } catch {
    return `${head}\n${SNAPSHOT_PART_FAILED(SNAPSHOT.vehicles)}`;
  }
  const parts = await Promise.all(
    PARTS.map(([label, part]) => part(ctx, ws, actor).catch(() => SNAPSHOT_PART_FAILED(label))),
  );
  return [head, ...parts.filter(Boolean)].join("\n");
}

const who = (ctx: McpContext) => {
  const p = ctx.person;
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
  return `${name}${p.username ? ` (@${p.username})` : ""}`;
};

export async function buildInitialize(ctx: McpContext, groups: ToolGroup[]): Promise<string> {
  const header = `# ECI Shuttle\nNow: ${formatIst(ctx.now)} IST\nYou are acting as: ${who(ctx)}, connected via ${ctx.client}`;
  const workspaces = ctx.workspaces.length
    ? (await Promise.all(ctx.workspaces.map((ws) => snapshot(ctx, ws)))).join("\n\n")
    : NO_WORKSPACES;
  const tools = groups.map((g) => g.section?.(ctx)).filter(Boolean);
  return [header, workspaces, ROLES_TEXT, RULES, tools.length ? `${TOOLS_HEADER}\n${tools.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

export function registerInitialize(server: McpServer, ctx: McpContext, groups: ToolGroup[]): void {
  server.registerTool(
    INITIALIZE_TOOL.name,
    {
      title: INITIALIZE_TOOL.title,
      description: INITIALIZE_TOOL.description,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withToolHandler(INITIALIZE_TOOL.name, ctx.person.id, async () => ok(await buildInitialize(ctx, groups))),
  );
}
