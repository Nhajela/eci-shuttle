import type {
  DirectiveKind,
  EpochMs,
  HHMM,
  Id,
  IsoDate,
  ServiceDef,
  ServiceExceptionDef,
  ServiceVehicleDef,
  VehicleWindow,
  Window,
} from "../contracts";
import { IST_OFFSET_MIN } from "../contracts";

const MIN = 60_000;
const DAY = 1440 * MIN;

const toMin = (t: HHMM) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** epoch ms of IST midnight starting `date` */
const dayStart = (date: IsoDate) => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MIN * MIN;
const istDate = (ms: number): IsoDate => new Date(ms + IST_OFFSET_MIN * MIN).toISOString().slice(0, 10);

function runsOn(s: ServiceDef, date: IsoDate, exceptions: ServiceExceptionDef[]): boolean {
  if (date < s.validFrom || date > s.validTo) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  if (!s.daysOfWeek.includes(weekday)) return false;
  return !exceptions.some((e) => e.serviceId === s.id && e.date === date && e.type === "cancel_day");
}

/** [start, end) of one service day, padded and widened by out-of-window departures (shift/add exceptions) */
function serviceDayWindow(s: ServiceDef, date: IsoDate, exceptions: ServiceExceptionDef[], pad: number) {
  const startMin = toMin(s.startTime);
  let endMin = toMin(s.endTime);
  if (endMin <= startMin) endMin += 1440; // cross-midnight (end == start: a full 24h day)
  // minutes from the service day's midnight; on cross-midnight days only times up to endTime roll past midnight,
  // gap times (after end, before start) stay on the service date: same rule as departures.ts onServiceDay
  const offset = (t: HHMM) =>
    endMin > 1440 && toMin(t) <= endMin - 1440 && toMin(t) < startMin ? toMin(t) + 1440 : toMin(t);
  const planned = (m: number) =>
    m >= startMin &&
    m < endMin &&
    (s.pattern.kind === "every"
      ? (m - startMin) % s.pattern.everyMin === 0
      : s.pattern.kind === "times" && s.pattern.times.some((t) => offset(t) === m));
  let lo = startMin;
  let hi = endMin;
  for (const e of exceptions) {
    if (e.serviceId !== s.id || e.date !== date || !e.departure) continue;
    const m = offset(e.departure);
    const at = e.type === "add_departure" ? m : e.type === "shift_minutes" && planned(m) ? m + (e.minutes ?? 0) : null;
    if (at === null) continue;
    lo = Math.min(lo, at);
    hi = Math.max(hi, at);
  }
  const base = dayStart(date);
  return [base + (lo - pad) * MIN, base + (hi + pad) * MIN] as const;
}

/** Per vehicle: sort, merge overlapping or touching windows (union serviceIds), sort by vehicleId then startsAt. */
function mergeWindows(ws: VehicleWindow[]): VehicleWindow[] {
  const sorted = ws
    .filter((w) => w.endsAt > w.startsAt)
    .sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : a.startsAt - b.startsAt));
  const out: VehicleWindow[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && last.vehicleId === w.vehicleId && w.startsAt <= last.endsAt) {
      last.endsAt = Math.max(last.endsAt, w.endsAt);
      for (const id of w.serviceIds) if (!last.serviceIds.includes(id)) last.serviceIds.push(id);
    } else out.push({ ...w, serviceIds: [...w.serviceIds] });
  }
  return out;
}

/**
 * When each vehicle should be tracking between `from` and `to` (epoch ms). Feeds the device config
 * (§4 schedule: Window[48h]) and the watchdog's "expected active". Pure.
 *
 * - For every service day overlapping [from, to): the service window startTime..endTime (cross-midnight aware),
 *   widened by `padMin` on both sides (default 15), skipped on non-running days and `cancel_day` exceptions.
 *   A departure moved/added outside the window (shift/add exceptions) widens that day's window to cover that
 *   departure time ± pad.
 * - Intersected with each service_vehicles row [startsAt, endsAt) for that service: a vehicle only tracks while
 *   assigned. Services with no assigned vehicles produce nothing.
 * - Clipped to [from, to). Per vehicle, overlapping or touching windows are merged and their serviceIds unioned.
 * - Result sorted by vehicleId, then startsAt.
 */
export function trackingWindows(
  serviceVehicles: ServiceVehicleDef[],
  services: ServiceDef[],
  exceptions: ServiceExceptionDef[],
  from: number,
  to: number,
  padMin = 15,
): VehicleWindow[] {
  const raw: VehicleWindow[] = [];
  for (const s of services) {
    const rows = serviceVehicles.filter((r) => r.serviceId === s.id);
    if (!rows.length) continue;
    // a service day can start the day before `from` (cross-midnight) and shifts/pad can reach further: look back 2 days
    for (let d = dayStart(istDate(from)) - 2 * DAY; d < to; d += DAY) {
      const date = istDate(d);
      if (!runsOn(s, date, exceptions)) continue;
      const [ws, we] = serviceDayWindow(s, date, exceptions, padMin);
      for (const r of rows) {
        const startsAt = Math.max(ws, r.startsAt, from);
        const endsAt = Math.min(we, r.endsAt, to);
        if (endsAt > startsAt) raw.push({ vehicleId: r.vehicleId, startsAt, endsAt, serviceIds: [s.id] });
      }
    }
  }
  return mergeWindows(raw);
}

/** A vehicle-targeted directive row (device-targeted ones are applied per phone in the device config). */
export type VehicleDirective = { vehicleId: Id; kind: DirectiveKind; startsAt: EpochMs; endsAt: EpochMs };

/**
 * trackingWindows output with directives applied, for "should this vehicle be tracking": `active_window` and
 * `force_active` add windows (no serviceIds), `silence_until` removes time and beats both. Pure.
 */
export function applyDirectives(windows: VehicleWindow[], directives: VehicleDirective[]): VehicleWindow[] {
  const adds = directives
    .filter((d) => d.kind !== "silence_until")
    .map((d) => ({ vehicleId: d.vehicleId, startsAt: d.startsAt, endsAt: d.endsAt, serviceIds: [] as Id[] }));
  let out = mergeWindows([...windows, ...adds]);
  for (const s of directives.filter((d) => d.kind === "silence_until")) {
    out = out.flatMap((w) =>
      w.vehicleId !== s.vehicleId || s.endsAt <= w.startsAt || s.startsAt >= w.endsAt
        ? [w]
        : [
            { ...w, endsAt: s.startsAt },
            { ...w, startsAt: s.endsAt },
          ].filter((p) => p.endsAt > p.startsAt),
    );
  }
  return out;
}

/** A workspace's daily ops tracking hours, IST; end <= start crosses midnight. */
export type OpsHours = { start: HHMM; end: HHMM };
/** A workspace row's ops tracking hours (`ops_hours_start` / `_end`), or null when not set. */
export const opsHoursOf = (ws: { opsHoursStart: string | null; opsHoursEnd: string | null }): OpsHours | null =>
  ws.opsHoursStart && ws.opsHoursEnd ? { start: ws.opsHoursStart, end: ws.opsHoursEnd } : null;

/**
 * Ops tracking hours as [startsAt, endsAt) spans overlapping [from, to), clipped to it, one per IST day. Phones
 * assigned to a vehicle track during them, off duty (positions for ops only, never public). Pure.
 */
export function opsHourSpans(
  hours: OpsHours | null,
  from: number,
  to: number,
): { startsAt: EpochMs; endsAt: EpochMs }[] {
  if (!hours) return [];
  const s = toMin(hours.start);
  const e = toMin(hours.end) <= s ? toMin(hours.end) + 1440 : toMin(hours.end);
  const out: { startsAt: EpochMs; endsAt: EpochMs }[] = [];
  // a span that started yesterday (cross-midnight) can still be open at `from`
  for (let d = dayStart(istDate(from)) - DAY; d < to; d += DAY) {
    const startsAt = Math.max(d + s * MIN, from);
    const endsAt = Math.min(d + e * MIN, to);
    if (endsAt > startsAt) out.push({ startsAt, endsAt });
  }
  return out;
}

/** Label of an ops-hours window in a phone's schedule (shown in its notification; tells them apart). */
export const OPS_HOURS_LABEL = "Ops hours";
/** A phone schedule without its ops-hours windows: what the vehicle is on duty for (silent alerts judge this). */
export const dutyWindows = (schedule: Window[]) => schedule.filter((w) => w.label !== OPS_HOURS_LABEL);

/** Is `t` inside the ops tracking hours? */
export const inOpsHours = (hours: OpsHours | null, t: number) => opsHourSpans(hours, t, t + 1).length > 0;
