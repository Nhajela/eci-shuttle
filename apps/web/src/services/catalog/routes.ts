/** svc-catalog: routes and path generation (SPEC §3, §7 Routes). ops+ writes, viewer+ reads. */
import {
  type LatLng,
  notImplemented,
  type PathSource,
  RouteCreateFields,
  RouteUpdateFields,
  withWorkspace,
} from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Route } from "@/db/types";
import type { Actor } from "../kernel";

export const CreateRouteInput = withWorkspace(RouteCreateFields);
export const UpdateRouteInput = withWorkspace(RouteUpdateFields);

export type GeneratedPath = { path: LatLng[]; source: PathSource; spotPathIdx: number[] };

/**
 * Road path through the points in order, from the public OSRM API
 * (https://router.project-osrm.org/route/v1/driving/…?overview=full&geometries=geojson), with a 5 s timeout.
 * On any failure: straight segments between the points (source "straight"). spotPathIdx[i] = index in path
 * nearest point i. `fetchImpl` is injectable for tests; never call OSRM from tests.
 */
export async function generatePath(points: LatLng[], fetchImpl: typeof fetch = fetch): Promise<GeneratedPath> {
  return notImplemented(points, fetchImpl);
}

/** ops+. All spotIds must be non-archived spots of this workspace (INVALID otherwise). Generates the path. */
export async function createRoute(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreateRouteInput>,
  deps?: { fetch?: typeof fetch },
): Promise<Route> {
  return notImplemented(db, actor, input, deps);
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
  return notImplemented(db, actor, input, deps);
}

/** viewer+. Non-archived routes with their learned typical_leg_s. */
export async function listRoutes(db: Db, actor: Actor, input: { workspaceId: string }): Promise<Route[]> {
  return notImplemented(db, actor, input);
}
