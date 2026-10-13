/** svc-devices: pairing codes and pairing (SPEC §4 pair, §5 first run, §7 Phones). */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { PairingCodeCreateFields, PairRequest, type PairResponse, withWorkspace } from "@eci-shuttle/shared";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { auditLog, devices, pairingCodes, workspaces } from "@/db/schema";
import { origin } from "@/lib/env";
import { type Actor, mutate, parseInput, requireRole, ServiceError } from "../kernel";
import { desiredConfig } from "./config";

export const CreatePairingCodeInput = withWorkspace(PairingCodeCreateFields);

export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export type PairingCodeResult = {
  /** 6 digits */
  code: string;
  /** `${origin}/pair/<code>`: what the QR encodes (the app reads the code from it) */
  qrUrl: string;
  expiresAt: Date;
};

/** admin only. A 6-digit code valid 10 min, bound to the workspace. Audited pairing_code.create. */
export async function createPairingCode(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreatePairingCodeInput>,
  now: Date = new Date(),
): Promise<PairingCodeResult> {
  const { workspaceId, label } = parseInput(CreatePairingCodeInput, input);
  requireRole(actor, workspaceId, "admin");
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  return mutate(db, actor, { action: "pairing_code.create", entity: "pairing_code", workspaceId }, async (tx) => {
    // code is the primary key; old unused codes linger until cleanup, so retry on a clash
    for (let i = 0; i < 10; i++) {
      const code = String(randomInt(1_000_000)).padStart(6, "0");
      const [row] = await tx
        .insert(pairingCodes)
        .values({
          code,
          workspaceId,
          label,
          createdByPersonId: actor.kind === "admin" ? actor.id : null,
          expiresAt,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (row)
        return {
          before: null,
          after: row,
          entityId: code,
          result: { code, qrUrl: `${origin()}/pair/${code}`, expiresAt },
        };
    }
    throw new ServiceError("CONFLICT", "Couldn't find a free pairing code. Try again.");
  });
}

/** Failed pairs (any code, any workspace) allowed per 10 min before every pair is refused. */
export const MAX_FAILED_PAIRS = 20;

const noSuchCode = () =>
  new ServiceError(
    "NOT_FOUND",
    "That pairing code doesn't work: it's wrong, used or expired. Make a new one in admin.",
  );

/**
 * POST /api/device/pair (no actor yet: the code is the credential). Swaps an unused, unexpired code for a new
 * device in the code's workspace: random 32-byte token, stored as sha256; label from the code's label or the
 * model. Unknown, used and expired all → the same NOT_FOUND, audited device.pair_failed (no workspace), and
 * after MAX_FAILED_PAIRS of those in 10 min every pair → RATE_LIMITED, so 6-digit codes can't be enumerated.
 * A `simulated` pair is stored as such and refused (FORBIDDEN, code left unused) when the code's workspace is
 * live. Marks the code used. Audited device.pair with the device as actor. Returns the token once, plus the initial
 * config. `now` for expiry; the throttle window is DB time, like audit_log.at.
 */
export async function pairDevice(db: Db, input: PairRequest, now: Date): Promise<PairResponse> {
  const req = parseInput(PairRequest, input);
  // ponytail: global cap, so a flood also blocks honest pairing for 10 min; the route should add a per-IP limit
  const [{ misses }] = await db
    .select({ misses: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "pairing_code"),
        eq(auditLog.action, "device.pair_failed"),
        gt(auditLog.at, sql`now() - interval '10 minutes'`),
      ),
    );
  if (misses >= MAX_FAILED_PAIRS)
    throw new ServiceError("RATE_LIMITED", "Too many wrong pairing codes. Wait 10 minutes, then try again.");

  const [row] = await db
    .select({ code: pairingCodes, isLive: workspaces.isLive })
    .from(pairingCodes)
    .innerJoin(workspaces, eq(workspaces.id, pairingCodes.workspaceId))
    .where(eq(pairingCodes.code, req.code));
  const code = row?.code;
  if (!code || code.usedAt || code.expiresAt <= now) {
    const unpaired: Actor = { kind: "device", id: "unpaired", channel: "device", label: req.model };
    await mutate(
      db,
      unpaired,
      { action: "device.pair_failed", entity: "pairing_code", entityId: req.code, workspaceId: null },
      async () => ({ before: null, after: null, result: null }),
    );
    throw noSuchCode();
  }
  // SPEC §3: sims never run in the live workspace. The code stays unused, so a real phone can still take it.
  if (req.simulated && row.isLive)
    throw new ServiceError("FORBIDDEN", "Simulated phones only pair into test workspaces, never the live one.");

  const deviceId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const label = code.label ?? (req.model.trim() || "Phone");
  const actor: Actor = { kind: "device", id: deviceId, workspaceId: code.workspaceId, channel: "device", label };

  return mutate(
    db,
    actor,
    { action: "device.pair", entity: "device", entityId: deviceId, workspaceId: code.workspaceId },
    async (tx) => {
      // claim first: the row lock makes a second phone racing for the same code see it used
      const [claimed] = await tx
        .update(pairingCodes)
        .set({ usedAt: now })
        .where(and(eq(pairingCodes.code, code.code), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)))
        .returning();
      if (!claimed) throw noSuchCode();
      const [device] = await tx
        .insert(devices)
        .values({
          id: deviceId,
          workspaceId: code.workspaceId,
          label,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          model: req.model,
          appVersion: req.appVersion,
          updateId: req.updateId,
          pushToken: req.pushToken,
          simulated: req.simulated ?? false,
        })
        .returning();
      await tx.update(pairingCodes).set({ deviceId }).where(eq(pairingCodes.code, code.code));
      const { tokenHash: _, ...audited } = device;
      return {
        before: null,
        after: audited,
        result: { deviceId, token, config: await desiredConfig(tx, deviceId, now) },
      };
    },
  );
}
