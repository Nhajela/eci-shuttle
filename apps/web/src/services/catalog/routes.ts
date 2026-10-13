/** svc-catalog: routes and path generation (SPEC §3, §7 Routes). ops+ writes, viewer+ reads. */
import { type LatLng, type PathSource, RouteCreateFields, RouteUpdateFields, withWorkspace } from "@eci-shuttle/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { legStats, routes, spots } from "@/db/schema";
import type { Route } from "@/db/types";
import {
  type Actor,
  checkVersion,
  getInWorkspace,
  inWorkspace,
  mutate,
  parseInput,
  readable,
  requireRole,
  ServiceError,
} from "../kernel";

export const CreateRouteInput = withWorkspace(RouteCreateFields);
export const UpdateRouteInput = withWorkspace(RouteUpdateFields);

export type GeneratedPath = { path: LatLng[]; source: PathSource; spotPathIdx: number[] };

const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const OSRM_TIMEOUT_MS = 5_000;

/**
 * For each point, the nearest path index. The first and last points are pinned to the path's ends (OSRM paths and
 * hand-drawn ones start at the first stop and end at the last; on a loop the end vertex can snap closer to the
 * first stop than the start does). Middle points search forward from the previous index. Equirectangular distance.
 */
export function spotIndexes(path: LatLng[], points: LatLng[]): number[] {
  const last = points.length - 1;
  let from = 0;
  return points.map((p, i) => {
    if (i === 0) return 0;
    if (i === last) return path.length - 1;
    const k = Math.cos((p.lat * Math.PI) / 180);
    let best = from;
    let bestD = Number.POSITIVE_INFINITY;
    for (let j = from; j < path.length - 1; j++) {
      const d = (path[j].lat - p.lat) ** 2 + ((path[j].lng - p.lng) * k) ** 2;
      if (d < bestD) [best, bestD] = [j, d];
    }
    from = best;
    return best;
  });
}

async function osrmPath(points: LatLng[], fetchImpl: typeof fetch): Promise<LatLng[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetchImpl(`${OSRM}${coords}?overview=full&geometries=geojson`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = (await res.json()) as {
      code?: string;
      routes?: { geometry?: { coordinates?: [number, number][] } }[];
    };
    const line = body.routes?.[0]?.geometry?.coordinates;
    if (body.code !== "Ok" || !line || line.length < 2) throw new Error(`OSRM ${body.code}`);
    return line.map(([lng, lat]) => ({ lat, lng }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Road path through the points in order, from the public OSRM API
 * (https://router.project-osrm.org/route/v1/driving/…?overview=full&geometries=geojson), with a 5 s timeout.
 * On any failure: straight segments between the points (source "straight"). spotPathIdx[i] = index in path
 * nearest point i. `fetchImpl` is injectable for tests; never call OSRM from tests.
 */
export async function generatePath(points: LatLng[], fetchImpl: typeof fetch = fetch): Promise<GeneratedPath> {
  try {
    const path = await osrmPath(points, fetchImpl);
    return { path, source: "osrm", spotPathIdx: spotIndexes(path, points) };
  } catch {
    const path = points.map(({ lat, lng }) => ({ lat, lng }));
    return { path, source: "straight", spotPathIdx: points.map((_, i) => i) };
  }
}

/** Coordinates of spotIds in order; INVALID unless every id is a spot of this workspace (non-archived if asked). */
async function spotPoints(db: Db, workspaceId: string, spotIds: string[], activeOnly: boolean): Promise<LatLng[]> {
  const rows = await db
    .select({ id: spots.id, lat: spots.lat, lng: spots.lng })
    .from(spots)
    .where(
      and(
        inWorkspace(spots, workspaceId),
        inArray(spots.id, spotIds),
        activeOnly ? isNull(spots.archivedAt) : undefined,
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, { lat: r.lat, lng: r.lng }]));
  const missing = spotIds.filter((id) => !byId.has(id));
  if (missing.length)
    throw new ServiceError("INVALID", "Every stop on a route must be an active spot in this workspace.", {
      spotIds: [...new Set(missing)],
    });
  return spotIds.map((id) => byId.get(id) as LatLng);
}

/** ops+. All spotIds must be non-archived spots of this workspace (INVALID otherwise). Generates the path. */
export async function createRoute(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreateRouteInput>,
  deps?: { fetch?: typeof fetch },
): Promise<Route> {
  const { workspaceId, name, spotIds } = parseInput(CreateRouteInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "route.create", entity: "route", workspaceId }, async (tx) => {
    const g = await generatePath(await spotPoints(tx, workspaceId, spotIds, true), deps?.fetch);
    const [row] = await tx
      .insert(routes)
      .values({ workspaceId, name, spotIds, path: g.path, pathSource: g.source, spotPathIdx: g.spotPathIdx })
      .returning();
    return { before: null, after: row, result: row };
  });
}

/**
 * ops+. spotIds change → path regenerated unless `path` given; `path` → pathSource "manual";
 * regeneratePath → regenerate. Bumps version; STALE_VERSION on a stale version. Bumps device configs of vehicles
 * on services using this route only if their windows change (they don't, for path edits).
 */
export async function updateRoute(
  db: Db,
  actor: Actor,
  input: z.input<typeof UpdateRouteInput>,
  deps?: { fetch?: typeof fetch },
): Promise<Route> {
  const { workspaceId, routeId, version, name, spotIds, path, regeneratePath } = parseInput(UpdateRouteInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "route.update", entity: "route", entityId: routeId, workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, routes, workspaceId, routeId, "route", { forUpdate: true });
    checkVersion(before, version, "route");
    const ids = spotIds ?? before.spotIds;
    // new stops must be active; existing ones may since have been archived and still anchor a manual path
    const points = spotIds || path || regeneratePath ? await spotPoints(tx, workspaceId, ids, !!spotIds) : null;
    // ponytail: OSRM is called inside the row lock (up to 5 s); fine for admin edits, move it out if it ever contends
    let g: GeneratedPath | null = null;
    if (points && path) g = { path, source: "manual", spotPathIdx: spotIndexes(path, points) };
    else if (points) g = await generatePath(points, deps?.fetch);
    const [after] = await tx
      .update(routes)
      .set({
        ...(name !== undefined && { name }),
        spotIds: ids,
        // typical_leg_s is one learned median per leg; new stops make the old legs meaningless
        ...(spotIds && spotIds.join() !== before.spotIds.join() && { typicalLegS: [] }),
        ...(g && { path: g.path, pathSource: g.source, spotPathIdx: g.spotPathIdx }),
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(routes.id, routeId))
      .returning();
    return { before, after, result: after };
  });
}

/** typicalLegS[i] null = leg i not learned yet; legSamples[i] = all-day regular-service samples of leg i (0 = none). */
export type RouteListItem = Omit<Route, "typicalLegS"> & { typicalLegS: (number | null)[]; legSamples: number[] };

/** viewer+. Non-archived routes with their learned typical_leg_s and per-leg sample counts. */
export async function listRoutes(db: Db, actor: Actor, input: { workspaceId: string }): Promise<RouteListItem[]> {
  readable(actor, input.workspaceId);
  const ws = input.workspaceId;
  const [rows, stats] = await Promise.all([
    db
      .select()
      .from(routes)
      .where(and(inWorkspace(routes, ws), isNull(routes.archivedAt)))
      .orderBy(asc(routes.name)),
    db
      .select({ from: legStats.fromSpotId, to: legStats.toSpotId, n: legStats.n })
      .from(legStats)
      .where(
        and(
          inWorkspace(legStats, ws),
          eq(legStats.kind, "leg"),
          isNull(legStats.serviceId),
          isNull(legStats.hourBucket),
        ),
      ),
  ]);
  const n = new Map(stats.map((s) => [`${s.from}>${s.to}`, s.n]));
  return rows.map((r) => ({
    ...r,
    // drizzle parses a NULL element of integer[] as NaN (schema types it number[]; learning writes nulls)
    typicalLegS: r.typicalLegS.map((s) => (Number.isNaN(s) ? null : s)),
    legSamples: r.spotIds.slice(1).map((to, i) => n.get(`${r.spotIds[i]}>${to}`) ?? 0),
  }));
}
