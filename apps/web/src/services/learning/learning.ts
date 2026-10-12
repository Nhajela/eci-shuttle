/** learning: leg_stats, segment_speeds, suggestions (SPEC §6a). Derived: not audited, except suggestion decisions. */
import { type EtaLeg, type LegEstimate, notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { Trip } from "@/db/types";

/** Cheap incremental update when a trip closes (called after ingest): refresh that leg's stats and segment speeds. */
export async function onTripClosed(db: Db, trip: Trip, now: Date): Promise<void> {
  return notImplemented(db, trip, now);
}

/**
 * Nightly (02:30 IST): recompute every leg_stats / segment_speeds row of the workspace from the last 7 service
 * days (dropping off-route / gap / > 3× median trips and excluded days; special services on their own legs),
 * refresh routes.typical_leg_s, and upsert suggestions (by dedupe_key; never touches accepted/dismissed ones).
 */
export async function recomputeAll(db: Db, workspaceId: string, now: Date): Promise<{ suggestions: number }> {
  return notImplemented(db, workspaceId, now);
}

/**
 * What etaToSpot needs for a route at `now`: one EtaLeg per leg (legEstimate on that leg's samples for the IST
 * hour bucket, with segment speeds) and the dwell estimate per spot. Special services use their own stats.
 */
export async function loadEstimates(
  db: Db,
  input: { workspaceId: string; routeId: string; serviceId: string | null },
  now: Date,
): Promise<{ legs: EtaLeg[]; dwells: Record<string, LegEstimate>; cycleS: number | null }> {
  return notImplemented(db, input, now);
}
