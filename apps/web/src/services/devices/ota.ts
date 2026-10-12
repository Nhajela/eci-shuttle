/** svc-devices: server-controlled OTA updates (SPEC §5). admin only. */
import { notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Workspace } from "@/db/types";
import type { Actor } from "../kernel";

export const RolloutInput = z.object({ workspaceId: z.uuid(), updateId: z.string().min(1).nullable() });
/** "Roll out update X to all phones in this workspace" (null = stop targeting). Bumps every config. */
export async function rolloutUpdate(db: Db, actor: Actor, input: z.input<typeof RolloutInput>): Promise<Workspace> {
  return notImplemented(db, actor, input);
}

export const PhoneUpdateInput = z.object({
  workspaceId: z.uuid(),
  deviceId: z.uuid(),
  updateId: z.string().min(1).nullable(),
});
/** Per-phone "update now" (override, null = follow the workspace). Bumps the config and pushes. */
export async function setPhoneUpdate(db: Db, actor: Actor, input: z.input<typeof PhoneUpdateInput>): Promise<void> {
  return notImplemented(db, actor, input);
}
