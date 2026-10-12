/** svc-devices: pairing codes and pairing (SPEC §4 pair, §5 first run, §7 Phones). */
import { notImplemented, PairingCodeCreateFields, type PairRequest, type PairResponse, withWorkspace } from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Actor } from "../kernel";

export const CreatePairingCodeInput = withWorkspace(PairingCodeCreateFields);

export type PairingCodeResult = {
  /** 6 digits */
  code: string;
  /** `${origin}/pair/<code>`: what the QR encodes (the app reads the code from it) */
  qrUrl: string;
  expiresAt: Date;
};

/** admin only. A 6-digit code valid 30 min, bound to the workspace. Audited pairing_code.create. */
export async function createPairingCode(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreatePairingCodeInput>,
): Promise<PairingCodeResult> {
  return notImplemented(db, actor, input);
}

/**
 * POST /api/device/pair (no actor yet: the code is the credential). Swaps an unused, unexpired code for a new
 * device in the code's workspace: random 32-byte token, stored as sha256; label from the code's label or the
 * model. Used/expired → GONE; unknown → NOT_FOUND. Marks the code used. Audited device.pair with the device as
 * actor. Returns the token once, plus the initial config. `now` for expiry.
 */
export async function pairDevice(db: Db, input: PairRequest, now: Date): Promise<PairResponse> {
  return notImplemented(db, input, now);
}
