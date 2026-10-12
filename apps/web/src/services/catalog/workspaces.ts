/** svc-catalog: workspaces (SPEC §3 Workspaces). */
import { notImplemented, WorkspaceCreateFields } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { Workspace } from "@/db/types";
import type { Actor } from "../kernel";

export const CreateWorkspaceInput = WorkspaceCreateFields;
/**
 * Create a (test) workspace. Any admin of any workspace may create one (system too); the creator becomes its
 * admin (membership row, same transaction). Never creates a live workspace (is_live is set by hand / seed).
 * Slug unique → CONFLICT. Audited as workspace.create with workspaceId = the new id.
 */
export async function createWorkspace(
  db: Db,
  actor: Actor,
  input: z.input<typeof CreateWorkspaceInput>,
): Promise<Workspace> {
  return notImplemented(db, actor, input);
}

export const UpdateWorkspaceInput = z.object({
  workspaceId: z.uuid(),
  version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  groupChatId: z.number().int().nullable().optional(),
  activeIntervalS: z.number().int().min(5).max(600).optional(),
  idleHeartbeatS: z.number().int().min(60).max(3600).optional(),
  minAppVersion: z.string().max(50).nullable().optional(),
  apkUrl: z.url().nullable().optional(),
});
/** Admin only. Changing intervals bumps every device config in the workspace (svc-devices bumpConfigs). */
export async function updateWorkspace(
  db: Db,
  actor: Actor,
  input: z.input<typeof UpdateWorkspaceInput>,
): Promise<Workspace> {
  return notImplemented(db, actor, input);
}

/** Public lookup (no actor): the workspace for `/` (is_live) or `/w/<slug>`. Null if none. */
export async function workspaceBySlug(db: Db, slug: string | null): Promise<Workspace | null> {
  return notImplemented(db, slug);
}

/** Workspaces the person behind `actor` is a member of, with their role, for the admin switcher. */
export async function listMyWorkspaces(
  db: Db,
  actor: Actor,
): Promise<(Workspace & { role: NonNullable<Actor["role"]> })[]> {
  return notImplemented(db, actor);
}
