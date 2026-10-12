/** svc-alerts: each admin's alert settings per workspace (SPEC §6c, alert_prefs) and quiet hours. */
import { AlertKind, HHMM, notImplemented } from "@eci-shuttle/shared";
import { z } from "zod";
import type { Db } from "@/db";
import type { AlertPrefs } from "@/db/types";
import type { Actor } from "../kernel";

/** What a member gets before they've saved any settings. */
export const DEFAULT_ALERT_KINDS: AlertKind[] = AlertKind.options.filter((k) => k !== "admin_changes");

export type EffectivePrefs = {
  kinds: AlertKind[];
  quietFrom: string | null;
  quietTo: string | null;
  /** null = defaults, no row yet */
  version: number | null;
};

/** viewer+, own prefs in that workspace (defaults when no row). */
export async function getAlertPrefs(db: Db, actor: Actor, input: { workspaceId: string }): Promise<EffectivePrefs> {
  return notImplemented(db, actor, input);
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
  return notImplemented(db, actor, input);
}

/**
 * Pure. If `now` is inside the IST quiet hours [from, to) (across midnight when to < from), the epoch ms they
 * end; otherwise null. null/equal times = never quiet. Alerts are held until then, not dropped.
 */
export function quietUntil(quietFrom: string | null, quietTo: string | null, now: number): number | null {
  return notImplemented(quietFrom, quietTo, now);
}
