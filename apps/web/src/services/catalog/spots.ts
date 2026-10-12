/** svc-catalog: spots (SPEC §3, §7 Spots). ops+ writes, viewer+ reads. */
import { notImplemented, SpotArchiveFields, SpotCreateFields, SpotUpdateFields, withWorkspace } from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Spot } from "@/db/types";
import type { Actor } from "../kernel";

export const CreateSpotInput = withWorkspace(SpotCreateFields);
export const UpdateSpotInput = withWorkspace(SpotUpdateFields);
export const ArchiveSpotInput = withWorkspace(SpotArchiveFields);

/** ops+. Audited spot.create. */
export async function createSpot(db: Db, actor: Actor, input: z.input<typeof CreateSpotInput>): Promise<Spot> {
  return notImplemented(db, actor, input);
}

/**
 * ops+. STALE_VERSION when input.version is stale; bumps version. Moving a spot or changing its radius does not
 * regenerate route paths (admin does that from Routes). Audited spot.update.
 */
export async function updateSpot(db: Db, actor: Actor, input: z.input<typeof UpdateSpotInput>): Promise<Spot> {
  return notImplemented(db, actor, input);
}

/** ops+. Sets archived_at; refuses (CONFLICT) while a non-archived route uses the spot. Audited spot.archive. */
export async function archiveSpot(db: Db, actor: Actor, input: z.input<typeof ArchiveSpotInput>): Promise<Spot> {
  return notImplemented(db, actor, input);
}

/** viewer+. Non-archived first by name; archived only when asked. */
export async function listSpots(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; includeArchived?: boolean },
): Promise<Spot[]> {
  return notImplemented(db, actor, input);
}
