/**
 * svc-devices: admin control of phones (SPEC §7 Phones, §4 directives). Every change that alters what a phone
 * should do bumps its config (config.bumpConfigs → configVersion+1 and a push). Roles: label, assign, silence,
 * force active, nudge = ops+; kill, revoke, move workspace = admin.
 */
import {
  notImplemented,
  type Permissions,
  PhoneAssignFields,
  PhoneForceActiveFields,
  PhoneKillFields,
  PhoneLabelFields,
  PhoneMoveWorkspaceFields,
  PhoneNudgeFields,
  PhoneRevokeFields,
  PhoneSilenceFields,
  withWorkspace,
} from "@eci-shuttle/shared";
import type { z } from "zod";
import type { Db } from "@/db";
import type { Device, DeviceAssignment, Directive, Vehicle } from "@/db/types";
import type { Actor } from "../kernel";

export const LabelPhoneInput = withWorkspace(PhoneLabelFields);
export const AssignPhoneInput = withWorkspace(PhoneAssignFields);
export const SilencePhoneInput = withWorkspace(PhoneSilenceFields);
export const ForceActiveInput = withWorkspace(PhoneForceActiveFields);
export const NudgePhoneInput = withWorkspace(PhoneNudgeFields);
export const KillPhoneInput = withWorkspace(PhoneKillFields);
export const RevokePhoneInput = withWorkspace(PhoneRevokeFields);
export const MovePhoneInput = withWorkspace(PhoneMoveWorkspaceFields);

export async function labelPhone(db: Db, actor: Actor, input: z.input<typeof LabelPhoneInput>): Promise<Device> {
  return notImplemented(db, actor, input);
}

/** Closes the open assignment (ends_at = now) and opens one for vehicleId (null = just unassign). A vehicle
 *  holding another phone loses it (that phone's assignment closes too). Bumps both phones' configs. */
export async function assignPhone(
  db: Db,
  actor: Actor,
  input: z.input<typeof AssignPhoneInput>,
): Promise<DeviceAssignment | null> {
  return notImplemented(db, actor, input);
}

/** A silence_until directive [now, until): idle even inside windows. */
export async function silencePhone(db: Db, actor: Actor, input: z.input<typeof SilencePhoneInput>): Promise<Directive> {
  return notImplemented(db, actor, input);
}

/** A force_active directive [now, until) with optional intervalS. */
export async function forceActive(db: Db, actor: Actor, input: z.input<typeof ForceActiveInput>): Promise<Directive> {
  return notImplemented(db, actor, input);
}

/** Cancel a silence/force directive early. */
export async function cancelDirective(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; directiveId: string },
): Promise<void> {
  return notImplemented(db, actor, input);
}

/** Push "sync now" without changing config (queues a push; audited phone.nudge). */
export async function nudgePhone(db: Db, actor: Actor, input: z.input<typeof NudgePhoneInput>): Promise<void> {
  return notImplemented(db, actor, input);
}

/** admin. Sets killed_at; the phone latches killed on next sync. Only the driver's Resume clears it. */
export async function killPhone(db: Db, actor: Actor, input: z.input<typeof KillPhoneInput>): Promise<Device> {
  return notImplemented(db, actor, input);
}

/** admin. Sets revoked_at, closes assignments; the token stops working after the next sync tells it so. */
export async function revokePhone(db: Db, actor: Actor, input: z.input<typeof RevokePhoneInput>): Promise<Device> {
  return notImplemented(db, actor, input);
}

/**
 * admin in BOTH workspaces (the second membership is looked up in the DB). Clears assignments and directives,
 * moves the device (and nothing else), bumps config. A simulated device can't move into the live workspace
 * (INVALID).
 */
export async function movePhoneToWorkspace(db: Db, actor: Actor, input: z.input<typeof MovePhoneInput>): Promise<Device> {
  return notImplemented(db, actor, input);
}

export type PhoneHealth = {
  device: Device;
  vehicle: Vehicle | null;
  /** desired mode right now (resolveMode on the desired config) vs device.reportedMode */
  desiredMode: string;
  modeMismatch: boolean;
  configBehind: boolean;
  lastSyncAgoS: number | null;
  needsNewApk: boolean;
  updateFailed: boolean;
  permissionsOk: boolean;
  permissions: Permissions | null;
  activeDirectives: Directive[];
};

/** viewer+. The Phones page and MCP shuttle_phones. Revoked phones last. */
export async function listPhones(
  db: Db,
  actor: Actor,
  input: { workspaceId: string },
  now: Date,
): Promise<PhoneHealth[]> {
  return notImplemented(db, actor, input, now);
}
