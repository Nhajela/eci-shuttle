import type { Db } from "@/db";
import { auditLog } from "@/db/schema";
import type { Actor } from "./actor";

type Row = Record<string, unknown>;

export type MutationMeta = {
  /** dotted verb, e.g. "spot.update", "phone.kill" */
  action: string;
  /** "spot", "device", "notice", … */
  entity: string;
  /** null when not known until fn runs (create): return it from fn as entityId, or after.id is used */
  entityId?: string | null;
  /** null only for global entities (people, tokens) or when fn returns it (workspace.create) */
  workspaceId: string | null;
  /** defaults to actor.reason */
  reason?: string;
  /** defaults to actor.proposalId */
  proposalId?: string;
};

export type Change<T> = {
  /** the row before (null on create) */
  before: object | null;
  /** the row after (null on delete) */
  after: object | null;
  /** what mutate() returns */
  result: T;
  entityId?: string;
  workspaceId?: string;
};

/** Never part of a diff: it changes on every write. */
const IGNORED = new Set(["updatedAt"]);

/** JSON-safe copy (Dates → ISO strings), so jsonb stores what an API would show. */
const plain = (o: object | null): Row | null => (o == null ? null : JSON.parse(JSON.stringify(o)));

/** Update → only the changed fields on each side. Create/delete → the whole row on its side. */
export function diff(before: object | null, after: object | null): { before: Row | null; after: Row | null } {
  const b = plain(before);
  const a = plain(after);
  if (!b || !a) return { before: b, after: a };
  const changedB: Row = {};
  const changedA: Row = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (IGNORED.has(k) || JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    changedB[k] = b[k] ?? null;
    changedA[k] = a[k] ?? null;
  }
  return { before: changedB, after: changedA };
}

/**
 * The only way to write domain data. Runs `fn` in a transaction (a savepoint when `db` is already a
 * transaction, so MCP confirm can run many mutations atomically) and writes exactly one audit_log row
 * in it, with the before → after diff. If fn throws, nothing is written.
 * Role checks happen before calling mutate (requireRole), not inside.
 */
export async function mutate<T>(
  db: Db,
  actor: Actor,
  meta: MutationMeta,
  fn: (tx: Db) => Promise<Change<T>>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const change = await fn(tx);
    const d = diff(change.before, change.after);
    const id = change.entityId ?? meta.entityId ?? ((change.after ?? change.before) as Row | null)?.id ?? null;
    await tx.insert(auditLog).values({
      workspaceId: change.workspaceId ?? meta.workspaceId,
      actorKind: actor.kind,
      actorId: actor.id,
      actorLabel: actor.label ?? null,
      channel: actor.channel,
      client: actor.client ?? null,
      action: meta.action,
      entity: meta.entity,
      entityId: id == null ? null : String(id),
      before: d.before,
      after: d.after,
      reason: meta.reason ?? actor.reason ?? null,
      proposalId: meta.proposalId ?? actor.proposalId ?? null,
    });
    return change.result;
  });
}
