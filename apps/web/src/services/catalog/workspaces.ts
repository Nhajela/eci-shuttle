/** svc-catalog: workspaces (SPEC §3 Workspaces). */
import { WorkspaceCreateFields } from "@eci-shuttle/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { memberships, workspaces } from "@/db/schema";
import type { Workspace } from "@/db/types";
import { bumpConfigs } from "../devices/config";
import { type Actor, checkVersion, mutate, parseInput, requireRole, ServiceError } from "../kernel";

/** Postgres unique_violation, raw or wrapped by drizzle (DrizzleQueryError.cause). */
const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

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
  const { slug, name } = parseInput(CreateWorkspaceInput, input);
  if (actor.kind !== "system") {
    // admin "of any workspace": checked against the DB, since the actor carries only one workspace's role
    const [m] =
      actor.kind === "admin"
        ? await db
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.personId, actor.id), eq(memberships.role, "admin")))
            .limit(1)
        : [];
    if (!m) throw new ServiceError("FORBIDDEN", "Only an admin can create a workspace.");
  }
  try {
    return await mutate(
      db,
      actor,
      { action: "workspace.create", entity: "workspace", workspaceId: null },
      async (tx) => {
        const [w] = await tx.insert(workspaces).values({ slug, name, isLive: false }).returning();
        if (actor.kind === "admin")
          await tx.insert(memberships).values({ personId: actor.id, workspaceId: w.id, role: "admin" });
        return { before: null, after: w, result: w, workspaceId: w.id };
      },
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new ServiceError("CONFLICT", `The slug "${slug}" is taken.`, { slug });
    throw e;
  }
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
/** Fields that are part of every phone's config (svc-devices desiredConfig). */
const DEVICE_FIELDS = ["activeIntervalS", "idleHeartbeatS", "minAppVersion", "apkUrl"] as const;

/** Admin only. Changing intervals bumps every device config in the workspace (svc-devices bumpConfigs). */
export async function updateWorkspace(
  db: Db,
  actor: Actor,
  input: z.input<typeof UpdateWorkspaceInput>,
): Promise<Workspace> {
  const { workspaceId, version, ...patch } = parseInput(UpdateWorkspaceInput, input);
  requireRole(actor, workspaceId, "admin");
  return mutate(
    db,
    actor,
    { action: "workspace.update", entity: "workspace", entityId: workspaceId, workspaceId },
    async (tx) => {
      const [before] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
      if (!before) throw new ServiceError("NOT_FOUND", "No such workspace.", { entity: "workspace", id: workspaceId });
      checkVersion(before, version, "workspace");
      const [after] = await tx
        .update(workspaces)
        .set({ ...patch, version: sql`${workspaces.version} + 1`, updatedAt: sql`now()` })
        .where(eq(workspaces.id, workspaceId))
        .returning();
      if (DEVICE_FIELDS.some((k) => before[k] !== after[k])) await bumpConfigs(tx, { workspaceId }, "workspace.update");
      return { before, after, result: after };
    },
  );
}

/** Public lookup (no actor): the workspace for `/` (is_live) or `/w/<slug>`. Null if none. */
export async function workspaceBySlug(db: Db, slug: string | null): Promise<Workspace | null> {
  const [w] = await db
    .select()
    .from(workspaces)
    .where(slug === null ? eq(workspaces.isLive, true) : eq(workspaces.slug, slug))
    .limit(1);
  return w ?? null;
}

/** Workspaces the person behind `actor` is a member of, with their role, for the admin switcher. */
export async function listMyWorkspaces(
  db: Db,
  actor: Actor,
): Promise<(Workspace & { role: NonNullable<Actor["role"]> })[]> {
  if (actor.kind !== "admin") return [];
  const rows = await db
    .select({ w: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.personId, actor.id))
    .orderBy(desc(workspaces.isLive), asc(workspaces.name));
  return rows.map((r) => ({ ...r.w, role: r.role }));
}
