/** svc-alerts: each admin's alert settings per workspace (SPEC §6c, alert_prefs) and quiet hours. */
import { AlertKind, HHMM, istDate, istHHMM, istToEpoch } from "@eci-shuttle/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { alertPrefs } from "@/db/schema";
import type { AlertPrefs } from "@/db/types";
import { type Actor, checkVersion, mutate, parseInput, readable, ServiceError } from "../kernel";

/** What a member gets before they've saved any settings. */
export const DEFAULT_ALERT_KINDS: AlertKind[] = AlertKind.options.filter((k) => k !== "admin_changes");

export type EffectivePrefs = {
  kinds: AlertKind[];
  quietFrom: string | null;
  quietTo: string | null;
  /** null = defaults, no row yet */
  version: number | null;
};

const own = (actor: Actor, workspaceId: string) =>
  and(eq(alertPrefs.personId, actor.id), eq(alertPrefs.workspaceId, workspaceId));

/** Settings belong to a person: viewer+ in the workspace, and a person (not a device or job). */
function requirePerson(actor: Actor, workspaceId: string): void {
  readable(actor, workspaceId);
  if (actor.kind !== "admin") throw new ServiceError("FORBIDDEN", "Only people have alert settings.");
}

/** viewer+, own prefs in that workspace (defaults when no row). */
export async function getAlertPrefs(db: Db, actor: Actor, input: { workspaceId: string }): Promise<EffectivePrefs> {
  const { workspaceId } = parseInput(z.object({ workspaceId: z.uuid() }), input);
  requirePerson(actor, workspaceId);
  const [row] = await db.select().from(alertPrefs).where(own(actor, workspaceId)).limit(1);
  return row
    ? { kinds: row.kinds, quietFrom: row.quietFrom, quietTo: row.quietTo, version: row.version }
    : { kinds: DEFAULT_ALERT_KINDS, quietFrom: null, quietTo: null, version: null };
}

export const SetAlertPrefsInput = z
  .object({
    workspaceId: z.uuid(),
    kinds: z.array(AlertKind).max(AlertKind.options.length),
    /** IST; both or neither; to < from = across midnight */
    quietFrom: HHMM.nullable(),
    quietTo: HHMM.nullable(),
    version: z.number().int().positive().optional(),
  })
  .refine((p) => (p.quietFrom === null) === (p.quietTo === null), "Set both quiet-hour times, or neither");

/** viewer+, own prefs. Upsert; STALE_VERSION on a stale version; bumps version. Audited alert_prefs.set. */
export async function setAlertPrefs(
  db: Db,
  actor: Actor,
  input: z.input<typeof SetAlertPrefsInput>,
): Promise<AlertPrefs> {
  const p = parseInput(SetAlertPrefsInput, input);
  requirePerson(actor, p.workspaceId);
  const values = { kinds: [...new Set(p.kinds)], quietFrom: p.quietFrom, quietTo: p.quietTo };
  const meta = { action: "alert_prefs.set", entity: "alert_prefs", workspaceId: p.workspaceId };
  return mutate(db, actor, meta, async (tx) => {
    const [before] = await tx.select().from(alertPrefs).where(own(actor, p.workspaceId)).for("update");
    if (before) checkVersion(before, p.version, "alert setting");
    const [after] = before
      ? await tx
          .update(alertPrefs)
          .set({ ...values, version: before.version + 1, updatedAt: new Date() })
          .where(eq(alertPrefs.id, before.id))
          .returning()
      : await tx
          .insert(alertPrefs)
          .values({ ...values, personId: actor.id, workspaceId: p.workspaceId })
          .returning();
    return { before: before ?? null, after, result: after };
  });
}

/**
 * Pure. If `now` is inside the IST quiet hours [from, to) (across midnight when to < from), the epoch ms they
 * end; otherwise null. null/equal times = never quiet. Alerts are held until then, not dropped.
 */
export function quietUntil(quietFrom: string | null, quietTo: string | null, now: number): number | null {
  if (!quietFrom || !quietTo || quietFrom === quietTo) return null;
  const t = istHHMM(now); // "HH:MM" compares correctly as text
  const inside = quietFrom < quietTo ? t >= quietFrom && t < quietTo : t >= quietFrom || t < quietTo;
  if (!inside) return null;
  const end = istToEpoch(istDate(now), quietTo);
  return end > now ? end : end + 86_400_000;
}
