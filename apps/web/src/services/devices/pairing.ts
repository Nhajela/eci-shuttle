/** svc-devices: pairing codes and pairing (SPEC §4 pair, §5 first run, §7 Phones). */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { PairingCodeCreateFields, PairRequest, type PairResponse, withWorkspace } from "@eci-shuttle/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/db";
import { devices, pairingCodes } from "@/db/schema";
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

/**
 * POST /api/device/pair (no actor yet: the code is the credential). Swaps an unused, unexpired code for a new
 * device in the code's workspace: random 32-byte token, stored as sha256; label from the code's label or the
 * model. Used/expired → GONE; unknown → NOT_FOUND. Marks the code used. Audited device.pair with the device as
 * actor. Returns the token once, plus the initial config. `now` for expiry.
 */
export async function pairDevice(db: Db, input: PairRequest, now: Date): Promise<PairResponse> {
  const req = parseInput(PairRequest, input);
  const [code] = await db.select().from(pairingCodes).where(eq(pairingCodes.code, req.code));
  if (!code) throw new ServiceError("NOT_FOUND", "That pairing code doesn't exist. Check the digits.");
  const gone = () => new ServiceError("GONE", "That pairing code was used or has expired. Make a new one in admin.");
  if (code.usedAt || code.expiresAt <= now) throw gone();

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
      if (!claimed) throw gone();
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
