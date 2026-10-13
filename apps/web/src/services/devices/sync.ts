/** svc-devices: POST /api/device/sync (SPEC §4). The route handler is a thin adapter over these two calls. */
import { createHash } from "node:crypto";
import { type Permissions, SyncRequest, type SyncResponse } from "@eci-shuttle/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { devices } from "@/db/schema";
import { ingestPings } from "../ingest/ingest";
import { type Actor, mutate, parseInput, requireDevice, ServiceError } from "../kernel";
import { onTripClosed } from "../learning/learning";
import { desiredConfig } from "./config";
import { alertKillResume } from "./phones";

/** Pings stamped further ahead of server time than this are dropped (a bad phone clock would poison ingest). */
export const MAX_FUTURE_MS = 2 * 60_000;
/** devices.clock_skew_ms is int4 */
const INT_MAX = 2 ** 31 - 1;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Bearer token → device actor ({kind: "device", id, workspaceId, channel: "device", label}). Unknown token →
 * UNAUTHENTICATED. A revoked device still authenticates (so it can be told it's revoked).
 */
export async function authenticateDevice(db: Db, bearer: string | null): Promise<Actor> {
  const token = bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ServiceError("UNAUTHENTICATED", "Missing device token.");
  const [d] = await db
    .select({ id: devices.id, workspaceId: devices.workspaceId, label: devices.label })
    .from(devices)
    .where(eq(devices.tokenHash, sha256(token)));
  if (!d) throw new ServiceError("UNAUTHENTICATED", "Unknown device token. Pair this phone again.");
  return { kind: "device", id: d.id, workspaceId: d.workspaceId, channel: "device", label: d.label };
}

const LOCATION_RANK = { denied: 0, foreground: 1, always: 2 } as const;

/** true when `now` has less than `before` in any permission. No stored report yet → nothing was lost. */
function permissionLost(before: Permissions | null, now: Permissions): boolean {
  if (!before) return false;
  if (LOCATION_RANK[now.location] < LOCATION_RANK[before.location]) return true;
  return (["preciseLocation", "notifications", "batteryOptimizationExempt"] as const).some((k) => before[k] && !now[k]);
}

/**
 * One sync: store reported state (battery, charging, permissions, mode, applied version, app/update ids, push
 * token, clock skew, last_sync_at; update_failed_at from updateFailed); ingest pings (ingest.ingestPings, which
 * dedupes on recorded_at); `resume: true` on a killed phone clears killed_at, audited device.resume with the
 * device as actor; a permission newly lost is audited device.permission_lost. Then return desiredConfig.
 * Killed/revoked phones' pings are dropped. Rate: one call per ~15 s per phone, ≤ 5000 pings per call.
 */
export async function syncDevice(db: Db, actor: Actor, raw: SyncRequest, now: Date): Promise<SyncResponse> {
  const input = parseInput(SyncRequest, raw);
  requireDevice(actor, actor.id);
  return db.transaction(async (tx) => {
    // row lock: a retry racing the original request waits instead of double-resuming
    const [d] = await tx.select().from(devices).where(eq(devices.id, actor.id)).for("update");
    if (!d) throw new ServiceError("UNAUTHENTICATED", "Unknown device. Pair this phone again.");
    const meta = { entity: "device", entityId: d.id, workspaceId: d.workspaceId };

    let killedAt = d.killedAt;
    if (input.resume && killedAt && !d.revokedAt) {
      const wasKilledAt = killedAt;
      await mutate(tx, actor, { ...meta, action: "device.resume" }, async (t) => {
        const [after] = await t
          .update(devices)
          .set({
            killedAt: null,
            configVersion: sql`${devices.configVersion} + 1`,
            version: sql`${devices.version} + 1`,
            updatedAt: now,
          })
          .where(eq(devices.id, d.id))
          .returning();
        await alertKillResume(t, after, "resumed", wasKilledAt, now);
        return { before: d, after, result: after };
      });
      killedAt = null;
    }

    // Telemetry: written every sync, so not audited (SPEC §7a); only a lost permission is.
    const state = {
      battery: input.battery,
      charging: input.charging,
      permissions: input.permissions,
      reportedMode: input.reportedMode,
      reportedConfigVersion: input.appliedConfigVersion,
      appVersion: input.appVersion,
      updateId: input.updateId,
      ...(input.pushToken !== undefined && { pushToken: input.pushToken }),
      ...(input.updateFailed !== undefined && {
        updateFailedAt: input.updateFailed ? (d.updateFailedAt ?? now) : null,
      }),
      clockSkewMs: Math.max(-INT_MAX, Math.min(INT_MAX, input.clock - now.getTime())),
      lastSyncAt: now,
    };
    const writeState = (t: Db) => t.update(devices).set(state).where(eq(devices.id, d.id));
    if (permissionLost(d.permissions, input.permissions)) {
      await mutate(tx, actor, { ...meta, action: "device.permission_lost" }, async (t) => {
        await writeState(t);
        return { before: { permissions: d.permissions }, after: { permissions: input.permissions }, result: null };
      });
    } else {
      await writeState(tx);
    }

    // Fix times come from the GPS, not the (skewed) phone clock, so they are kept as sent.
    const pings = input.pings.filter((p) => p.recordedAt <= now.getTime() + MAX_FUTURE_MS);
    if (!killedAt && !d.revokedAt && pings.length) {
      const res = await ingestPings(tx, { workspaceId: d.workspaceId, deviceId: d.id, pings }, now);
      for (const trip of res.closedTrips) await onTripClosed(tx, trip, now);
      // ponytail: res.vehicleIds (arrival alerts) not acted on here: no exported alert service exists yet.
    }

    return desiredConfig(tx, d.id, now);
  });
}
