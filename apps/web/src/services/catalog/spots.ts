/** svc-catalog: spots (SPEC §3, §7 Spots). ops+ writes, viewer+ reads. */
import {
  distanceM,
  type LatLng,
  SpotArchiveFields,
  SpotCreateFields,
  SpotUpdateFields,
  withWorkspace,
} from "@eci-shuttle/shared";
import { and, arrayContains, asc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { routes, spots } from "@/db/schema";
import type { Spot } from "@/db/types";
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

export const CreateSpotInput = withWorkspace(SpotCreateFields);
export const UpdateSpotInput = withWorkspace(SpotUpdateFields);
export const ArchiveSpotInput = withWorkspace(SpotArchiveFields);

/** ops+. Audited spot.create. */
export async function createSpot(db: Db, actor: Actor, input: z.input<typeof CreateSpotInput>): Promise<Spot> {
  const { workspaceId, ...fields } = parseInput(CreateSpotInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "spot.create", entity: "spot", workspaceId }, async (tx) => {
    const [row] = await tx
      .insert(spots)
      .values({ workspaceId, ...fields })
      .returning();
    return { before: null, after: row, result: row };
  });
}

/**
 * ops+. STALE_VERSION when input.version is stale; bumps version. Moving a spot or changing its radius does not
 * regenerate route paths (admin does that from Routes). Audited spot.update.
 */
export async function updateSpot(db: Db, actor: Actor, input: z.input<typeof UpdateSpotInput>): Promise<Spot> {
  const { workspaceId, spotId, version, ...fields } = parseInput(UpdateSpotInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "spot.update", entity: "spot", entityId: spotId, workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, spots, workspaceId, spotId, "spot", { forUpdate: true });
    checkVersion(before, version, "spot");
    const [after] = await tx
      .update(spots)
      .set({ ...fields, version: before.version + 1, updatedAt: new Date() })
      .where(eq(spots.id, spotId))
      .returning();
    return { before, after, result: after };
  });
}

/** ops+. Sets archived_at; refuses (CONFLICT) while a non-archived route uses the spot. Audited spot.archive. */
export async function archiveSpot(db: Db, actor: Actor, input: z.input<typeof ArchiveSpotInput>): Promise<Spot> {
  const { workspaceId, spotId, version } = parseInput(ArchiveSpotInput, input);
  requireRole(actor, workspaceId, "ops");
  return mutate(db, actor, { action: "spot.archive", entity: "spot", entityId: spotId, workspaceId }, async (tx) => {
    const before = await getInWorkspace(tx, spots, workspaceId, spotId, "spot", { forUpdate: true });
    checkVersion(before, version, "spot");
    if (before.archivedAt) throw new ServiceError("CONFLICT", `${before.name} is already archived.`, { spotId });
    const using = await tx
      .select({ id: routes.id, name: routes.name })
      .from(routes)
      .where(and(inWorkspace(routes, workspaceId), isNull(routes.archivedAt), arrayContains(routes.spotIds, [spotId])));
    if (using.length)
      throw new ServiceError(
        "CONFLICT",
        `${before.name} is used by ${using.map((r) => r.name).join(", ")}. Change or archive those routes first.`,
        { spotId, routeIds: using.map((r) => r.id) },
      );
    const now = new Date();
    const [after] = await tx
      .update(spots)
      .set({ archivedAt: now, version: before.version + 1, updatedAt: now })
      .where(eq(spots.id, spotId))
      .returning();
    return { before, after, result: after };
  });
}

/** viewer+. Non-archived first by name; archived only when asked. */
export async function listSpots(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; includeArchived?: boolean },
): Promise<Spot[]> {
  readable(actor, input.workspaceId);
  return db
    .select()
    .from(spots)
    .where(and(inWorkspace(spots, input.workspaceId), input.includeArchived ? undefined : isNull(spots.archivedAt)))
    .orderBy(sql`${spots.archivedAt} is not null`, asc(spots.name));
}

/**
 * System read (no actor: the bot router runs before anyone is known; spot names are public). True when `text`,
 * trimmed and any case, is exactly a non-archived spot's short name or name in this workspace.
 */
export async function isSpotName(db: Db, workspaceId: string, text: string): Promise<boolean> {
  const q = text.trim().toLowerCase();
  if (!q) return false;
  const [hit] = await db
    .select({ id: spots.id })
    .from(spots)
    .where(
      and(
        inWorkspace(spots, workspaceId),
        isNull(spots.archivedAt),
        sql`(lower(${spots.shortName}) = ${q} or lower(${spots.name}) = ${q})`,
      ),
    )
    .limit(1);
  return !!hit;
}

// ---------- overlap warning ----------

type Fence = LatLng & { radiusM: number };

/**
 * Pure. One plain-English warning per other spot whose geofence overlaps this one (centres closer than the sum of
 * radii). Overlap is allowed (the nearest centre wins at ingest), so this only warns. `spot.id` is skipped in others.
 */
export function overlapWarnings(spot: Fence & { id?: string }, others: (Fence & { id: string; name: string })[]) {
  return others
    .filter((o) => o.id !== spot.id)
    .map((o) => ({ o, d: distanceM(spot, o) }))
    .filter(({ o, d }) => d < spot.radiusM + o.radiusM)
    .map(
      ({ o, d }) =>
        `This spot's area overlaps ${o.name} (${Math.round(d)} m apart). A shuttle there counts as at the nearer one.`,
    );
}

/**
 * viewer+. Warnings for a spot being created or moved (pass spotId when editing) against the workspace's
 * non-archived spots. For admin forms and shuttle_propose; create/update never refuse on overlap.
 */
export async function spotOverlapWarnings(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; lat: number; lng: number; radiusM?: number; spotId?: string },
): Promise<string[]> {
  const others = await listSpots(db, actor, { workspaceId: input.workspaceId });
  return overlapWarnings({ ...input, id: input.spotId, radiusM: input.radiusM ?? 75 }, others);
}
