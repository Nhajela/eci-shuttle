/**
 * web-mcp read tools (SPEC §7a): reads go direct, no propose/confirm. Thin adapters: parse, resolve the workspace,
 * build the MCP admin Actor, call one service, shape the result for a model (times in IST, no secrets).
 * Errors are ServiceErrors; the MCP route maps them once.
 */
import { formatIst, IsoDate, istDate, istHHMM, SuggestionStatus } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Workspace } from "@/db/types";
import { ActivityQuery, describeAudit, listActivity } from "@/services/activity/activity";
import { adminActor, resolveWorkspace } from "@/services/auth/actor";
import { listRoutes } from "@/services/catalog/routes";
import { getSchedule } from "@/services/catalog/schedule";
import { listSpots } from "@/services/catalog/spots";
import { listVehicles } from "@/services/catalog/vehicles";
import { workspaceBySlug } from "@/services/catalog/workspaces";
import { listPhones } from "@/services/devices/phones";
import { vehicleStates } from "@/services/ingest/ingest";
import { type Actor, parseInput, ServiceError } from "@/services/kernel";
import { getInsights, listSuggestions } from "@/services/learning/insights";
import { publicStatus } from "@/services/public/status";

/** Every text a model sees from these tools. */
export const READ_TEXT = {
  shuttle_status:
    "Live board right now: every vehicle in the workspace with its live state (phase, current / next spot, ETA, last ping). state is null for a vehicle that has never reported.",
  shuttle_schedule:
    "The timetable for one day (default today, IST) or up to 14 days: each service with its one-day exceptions, assigned vehicles and planned departures (IST HH:MM, after exceptions).",
  shuttle_spots: "Pickup spots of the workspace (archived ones only when includeArchived is true).",
  shuttle_routes: "Routes: their ordered spot ids and learned typical leg times. The path polyline is left out.",
  shuttle_vehicles: "Vehicles of the workspace, active first.",
  shuttle_phones:
    "Driver phone health: desired vs reported mode, config behind, last sync, app version, permissions, active silence / force-active directives.",
  shuttle_activity:
    "The audit log, newest first: who changed what, from where. Filter by entity (+ entityId for one object's timeline), actorId, proposalId (everything one confirm did) or since. Page with before = nextBefore.",
  shuttle_public_answer:
    "Exactly what attendees see right now, on the public page and the bot. Use it to check a change landed. Optional spot (id, name or short name) narrows it to one spot.",
  shuttle_insights:
    "Punctuality and learning for a date range (default the last 7 days, IST): on-time %, delay by slot, dwell, leg times, loop cycle, % tracked, average wait. Admin-only data: never tell attendees about lateness.",
  shuttle_suggestions:
    "Timetable suggestions from the nightly job, with their evidence and proposed changes. They never apply themselves: accepting one goes through shuttle_propose / shuttle_confirm.",
  workspaceArg: "Workspace slug. Leave out for your live workspace (or your first one).",
  noWorkspace: (slug: string) => `There's no workspace called "${slug}".`,
  noMemberships: "You're not a member of any workspace yet. Ask an admin to add you.",
  noSpot: (spot: string, names: string[]) =>
    `No spot "${spot}" on today's public page. Spots shown: ${names.join(", ") || "none"}.`,
} as const;

/** Who is calling, from the MCP route (mcp/tokens.authenticateMcp). */
export type McpContext = { db: Db; personId: string; client?: string; now: Date };
type Scope = { db: Db; actor: Actor; workspace: Workspace; now: Date };

/** The named workspace (unknown → NOT_FOUND, never a fallback), else the person's live one, else their first. */
export async function resolveScope(ctx: McpContext, slug?: string): Promise<Scope> {
  let workspace: Workspace | null;
  if (slug) {
    workspace = await workspaceBySlug(ctx.db, slug);
    if (!workspace) throw new ServiceError("NOT_FOUND", READ_TEXT.noWorkspace(slug), { slug });
  } else {
    const mine = await resolveWorkspace(ctx.db, ctx.personId, null);
    if (!mine) throw new ServiceError("FORBIDDEN", READ_TEXT.noMemberships);
    workspace = mine.workspace;
  }
  const actor = await adminActor(ctx.db, {
    personId: ctx.personId,
    workspaceId: workspace.id,
    channel: "mcp",
    client: ctx.client,
  });
  return { db: ctx.db, actor, workspace, now: ctx.now };
}

const HIDDEN = new Set(["tokenHash", "pushToken"]);

/** Dates → "Mon 12 Oct, 09:40 IST"; device secrets dropped. */
export function toModel(v: unknown): unknown {
  if (v instanceof Date) return `${formatIst(v)} IST`;
  if (Array.isArray(v)) return v.map(toModel);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !HIDDEN.has(k))
        .map(([k, x]) => [k, toModel(x)]),
    );
  return v;
}

const ws = { workspace: z.string().min(1).optional().describe(READ_TEXT.workspaceArg) };

function tool<N extends keyof typeof READ_TEXT, S extends z.ZodObject<typeof ws>>(
  name: N,
  input: S,
  handler: (s: Scope, input: z.output<S>) => Promise<unknown>,
) {
  return {
    name,
    description: READ_TEXT[name] as string,
    input,
    async run(ctx: McpContext, raw: unknown): Promise<unknown> {
      const parsed = parseInput(input, raw ?? {});
      return toModel(await handler(await resolveScope(ctx, parsed.workspace), parsed));
    },
  };
}

const DAY_MS = 86_400_000;

export const READ_TOOLS = [
  tool("shuttle_status", z.object(ws), async ({ db, actor, workspace, now }) => {
    // listVehicles checks the viewer role; vehicleStates has no actor, so it must come second
    const vehicles = await listVehicles(db, actor, { workspaceId: workspace.id });
    const states = await vehicleStates(db, workspace.id);
    return {
      workspace: { slug: workspace.slug, name: workspace.name, isLive: workspace.isLive },
      now,
      vehicles: vehicles.map((vehicle) => ({
        vehicle,
        state: states.find((s) => s.vehicleId === vehicle.id) ?? null,
      })),
    };
  }),

  tool(
    "shuttle_schedule",
    z.object({ ...ws, date: IsoDate.optional(), days: z.number().int().min(1).max(14).default(1) }),
    async ({ db, actor, workspace, now }, i) => {
      const days = await getSchedule(db, actor, {
        workspaceId: workspace.id,
        from: i.date ?? istDate(now),
        days: i.days,
      });
      return days.map((d) => ({
        ...d,
        services: d.services.map((s) => ({ ...s, departures: s.departures.map((p) => ({ ...p, at: istHHMM(p.at) })) })),
      }));
    },
  ),

  tool("shuttle_spots", z.object({ ...ws, includeArchived: z.boolean().optional() }), ({ db, actor, workspace }, i) =>
    listSpots(db, actor, { workspaceId: workspace.id, includeArchived: i.includeArchived }),
  ),

  tool("shuttle_routes", z.object(ws), async ({ db, actor, workspace }) =>
    (await listRoutes(db, actor, { workspaceId: workspace.id })).map(({ path, ...r }) => ({
      ...r,
      pathPoints: path.length,
    })),
  ),

  tool("shuttle_vehicles", z.object(ws), ({ db, actor, workspace }) =>
    listVehicles(db, actor, { workspaceId: workspace.id }),
  ),

  tool("shuttle_phones", z.object(ws), ({ db, actor, workspace, now }) =>
    listPhones(db, actor, { workspaceId: workspace.id }, now),
  ),

  tool(
    "shuttle_activity",
    ActivityQuery.omit({ workspaceId: true }).extend(ws),
    async ({ db, actor, workspace }, { workspace: _, ...q }) => {
      const page = await listActivity(db, actor, { ...q, workspaceId: workspace.id });
      return {
        rows: page.rows.map((r) => ({ text: `${formatIst(r.at)} IST: ${describeAudit(r)}`, ...r })),
        nextBefore: page.nextBefore,
      };
    },
  ),

  tool(
    "shuttle_public_answer",
    z.object({ ...ws, spot: z.string().trim().min(1).optional() }),
    async ({ db, workspace, now }, i) => {
      const status = await publicStatus(db, workspace.id, now);
      if (!i.spot) return status;
      const want = i.spot.toLowerCase();
      const spot = status.spots.find(
        (s) => s.spotId === i.spot || s.name.toLowerCase() === want || s.shortName.toLowerCase() === want,
      );
      if (!spot)
        throw new ServiceError(
          "NOT_FOUND",
          READ_TEXT.noSpot(
            i.spot,
            status.spots.map((s) => s.name),
          ),
        );
      return { ...status, spots: [spot] };
    },
  ),

  tool(
    "shuttle_insights",
    z.object({ ...ws, from: IsoDate.optional(), to: IsoDate.optional() }),
    ({ db, actor, workspace, now }, i) =>
      getInsights(db, actor, {
        workspaceId: workspace.id,
        from: i.from ?? istDate(+now - 6 * DAY_MS),
        to: i.to ?? istDate(now),
      }),
  ),

  tool("shuttle_suggestions", z.object({ ...ws, status: SuggestionStatus.optional() }), ({ db, actor, workspace }, i) =>
    listSuggestions(db, actor, { workspaceId: workspace.id, status: i.status }),
  ),
];

export type ReadTool = (typeof READ_TOOLS)[number];

export function readTool(name: string): ReadTool {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown read tool ${name}`);
  return t;
}
