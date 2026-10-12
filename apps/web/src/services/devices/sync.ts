/** svc-devices: POST /api/device/sync (SPEC §4). The route handler is a thin adapter over these two calls. */
import { notImplemented, type SyncRequest, type SyncResponse } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { Actor } from "../kernel";

/**
 * Bearer token → device actor ({kind: "device", id, workspaceId, channel: "device", label}). Unknown token →
 * UNAUTHENTICATED. A revoked device still authenticates (so it can be told it's revoked).
 */
export async function authenticateDevice(db: Db, bearer: string | null): Promise<Actor> {
  return notImplemented(db, bearer);
}

/**
 * One sync: store reported state (battery, charging, permissions, mode, applied version, app/update ids, push
 * token, clock skew, last_sync_at; update_failed_at from updateFailed); ingest pings (ingest.ingestPings, which
 * dedupes on recorded_at); `resume: true` on a killed phone clears killed_at, audited device.resume with the
 * device as actor; a permission newly lost is audited device.permission_lost. Then return desiredConfig.
 * Killed/revoked phones' pings are dropped. Rate: one call per ~15 s per phone, ≤ 5000 pings per call.
 */
export async function syncDevice(db: Db, actor: Actor, input: SyncRequest, now: Date): Promise<SyncResponse> {
  return notImplemented(db, actor, input, now);
}
