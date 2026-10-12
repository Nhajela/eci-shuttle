import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import type { Actor } from "./actor";
import { ServiceError } from "./errors";
import { requireRole } from "./roles";

type ScopedTable = PgTable & { id: AnyPgColumn; workspaceId: AnyPgColumn };

/** `where` clause for a workspace-scoped read: every query on a domain table includes it. */
export const inWorkspace = (table: { workspaceId: AnyPgColumn }, workspaceId: string): SQL =>
  eq(table.workspaceId, workspaceId);

/** Reads need at least viewer in that workspace (system passes). */
export const readable = (actor: Actor, workspaceId: string): void => requireRole(actor, workspaceId, "viewer");

/** One row by id, only if it belongs to the workspace. */
export async function findInWorkspace<T extends ScopedTable>(
  db: Db,
  table: T,
  workspaceId: string,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<T["$inferSelect"] | null> {
  const q = db
    .select()
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    .limit(1);
  const rows = await (opts.forUpdate ? q.for("update") : q);
  return (rows[0] as T["$inferSelect"] | undefined) ?? null;
}

/** Like findInWorkspace but throws NOT_FOUND (another workspace's row is indistinguishable from none). */
export async function getInWorkspace<T extends ScopedTable>(
  db: Db,
  table: T,
  workspaceId: string,
  id: string,
  entity: string,
  opts: { forUpdate?: boolean } = {},
): Promise<T["$inferSelect"]> {
  const row = await findInWorkspace(db, table, workspaceId, id, opts);
  if (!row) throw new ServiceError("NOT_FOUND", `No such ${entity}.`, { entity, id });
  return row;
}

/** Optimistic concurrency: when the caller says which version it edited, it must still be current. */
export function checkVersion(row: { version: number }, expected: number | undefined, entity: string): void {
  if (expected !== undefined && row.version !== expected)
    throw new ServiceError("STALE_VERSION", `This ${entity} was changed by someone else. Reload and try again.`, {
      entity,
      expected,
      actual: row.version,
    });
}
