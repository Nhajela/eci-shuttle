/** admin-activity: pure helpers for the Activity page (search params ↔ listActivity query, grouping, diffs). */
import { formatIst, istDate, istToEpoch } from "@eci-shuttle/shared";
import type { AuditRow } from "@/db/types";

/** What the page's URL can filter on. `w` is the workspace slug, carried through every link. */
export type ActivityFilters = {
  w?: string;
  entity?: string;
  entityId?: string;
  actor?: string;
  proposal?: string;
  /** IST date "YYYY-MM-DD": rows from the start of that day */
  since?: string;
};

type SearchParams = Record<string, string | string[] | undefined>;

/** audit_log.entity values with a plain label, for the filter menu. */
export const ENTITIES: { value: string; label: string }[] = [
  { value: "spot", label: "Spots" },
  { value: "route", label: "Routes" },
  { value: "service", label: "Schedule" },
  { value: "service_vehicle", label: "Vehicle assignments" },
  { value: "vehicle", label: "Vehicles" },
  { value: "device", label: "Phones" },
  { value: "pairing_code", label: "Pairing codes" },
  { value: "notice", label: "Notices" },
  { value: "membership", label: "Roles" },
  { value: "workspace", label: "Workspaces" },
  { value: "suggestion", label: "Suggestions" },
  { value: "subscription", label: "Subscriptions" },
];

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const isIstDate = (d: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(istToEpoch(d, "00:00")) && istDate(istToEpoch(d, "00:00")) === d;

/** URL search params → listActivity input + the filters actually applied. Bad values are dropped, not errors. */
export function parseActivityParams(sp: SearchParams, workspaceId: string) {
  const f: ActivityFilters = {};
  for (const k of ["w", "entity", "actor", "proposal"] as const) {
    const v = one(sp[k]);
    if (v) f[k] = v;
  }
  const entityId = one(sp.entityId);
  if (entityId && f.entity) f.entityId = entityId;
  const since = one(sp.since);
  if (since && isIstDate(since)) f.since = since;
  const before = Number(one(sp.before));

  return {
    filters: f,
    query: {
      workspaceId,
      ...(f.entity && { entity: f.entity }),
      ...(f.entityId && { entityId: f.entityId }),
      ...(f.actor && { actorId: f.actor }),
      ...(f.proposal && { proposalId: f.proposal }),
      ...(f.since && { since: new Date(istToEpoch(f.since, "00:00")).toISOString() }),
      ...(Number.isSafeInteger(before) && before > 0 && { before }),
      limit: 50,
    },
  };
}

/** Link to the Activity page with `patch` applied to the current filters (undefined removes one). */
export function activityHref(current: ActivityFilters, patch: ActivityFilters & { before?: number }): string {
  const next: Record<string, string | number | undefined> = { ...current, ...patch };
  // an object timeline without its entity type means nothing
  if (!next.entity) next.entityId = undefined;
  const qs = new URLSearchParams();
  for (const k of ["w", "entity", "entityId", "actor", "proposal", "since", "before"])
    if (next[k] !== undefined && next[k] !== "") qs.set(k, String(next[k]));
  const s = qs.toString();
  return s ? `/admin/activity?${s}` : "/admin/activity";
}

/** Newest-first rows → one group per IST day, e.g. { day: "2026-10-12", label: "Mon 12 Oct" }. */
export function groupByDay(rows: AuditRow[]): { day: string; label: string; rows: AuditRow[] }[] {
  const days: { day: string; label: string; rows: AuditRow[] }[] = [];
  for (const r of rows) {
    const day = istDate(r.at);
    const last = days[days.length - 1];
    if (last?.day === day) last.rows.push(r);
    else days.push({ day, label: formatIst(r.at).split(",")[0], rows: [r] });
  }
  return days;
}

const show = (v: unknown): string => (v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v));

/** The before → after diff as rows for the details view. null side = the row didn't exist (create / delete). */
export function diffEntries(row: AuditRow): { field: string; before: string | null; after: string | null }[] {
  const keys = new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})]);
  keys.delete("version");
  return [...keys].map((field) => ({
    field,
    before: row.before ? show(row.before[field]) : null,
    after: row.after ? show(row.after[field]) : null,
  }));
}
