import type { Departure, HHMM, IsoDate, ServiceDef, ServiceExceptionDef } from "../contracts";

const MIN = 60_000;
const IST_OFFSET_MIN = 330;
const toMin = (t: HHMM) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m: number) => {
  const d = m % 1440;
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

/**
 * Planned departures (from the route's first spot) of one service on one IST service day, after exceptions,
 * sorted by time. Pure.
 *
 * - Returns [] when `date` is outside validFrom..validTo (inclusive), its IST weekday (1=Mon..7=Sun) isn't in
 *   daysOfWeek, or there is a `cancel_day` exception for that date.
 * - pattern `every`: startTime, startTime+N, … while < endTime. pattern `times`: those times that fall inside
 *   the service window (both ends inclusive). pattern `loop`: [] (no fixed departures).
 * - Cross-midnight: endTime < startTime means the window runs to endTime on the next calendar day; times after
 *   midnight (e.g. 01:00 for a 22:00–02:00 service) get `at` on date+1 but still `date` as their service day.
 * - Exceptions for other services or other dates are ignored. `cancel_departure` removes the matching planned
 *   time; `shift_minutes` moves it (`shiftedMin` set, `planned` keeps the original); `add_departure` adds one
 *   (`added: true`) even outside the window. Exceptions naming a time that isn't planned are ignored.
 * - IST is UTC+05:30 with no DST: `at` is the epoch ms of that IST wall-clock time.
 */
export function expandServiceDepartures(
  service: ServiceDef,
  exceptions: ServiceExceptionDef[],
  date: IsoDate,
): Departure[] {
  const mine = exceptions.filter((e) => e.serviceId === service.id && e.date === date);
  const dayUtc = Date.parse(`${date}T00:00:00Z`);
  const weekday = ((new Date(dayUtc).getUTCDay() + 6) % 7) + 1;
  if (
    date < service.validFrom ||
    date > service.validTo ||
    !service.daysOfWeek.includes(weekday) ||
    mine.some((e) => e.type === "cancel_day")
  )
    return [];

  const start = toMin(service.startTime);
  const rawEnd = toMin(service.endTime);
  const crosses = rawEnd < start;
  const end = crosses ? rawEnd + 1440 : rawEnd;
  // minutes since the service day's midnight; after-midnight times of a cross-midnight service go past 1440
  const onServiceDay = (t: HHMM) => (crosses && toMin(t) < start ? toMin(t) + 1440 : toMin(t));

  let mins: number[] = [];
  const p = service.pattern;
  if (p.kind === "every") for (let m = start; m < end; m += p.everyMin) mins.push(m);
  else if (p.kind === "times") mins = [...new Set(p.times.map(onServiceDay))].filter((m) => m >= start && m <= end);

  const at = (m: number) => dayUtc + (m - IST_OFFSET_MIN) * MIN;
  const naming = (type: ServiceExceptionDef["type"], m: number) =>
    mine.filter((e) => e.type === type && e.departure !== null && onServiceDay(e.departure) === m);

  const out: Departure[] = [];
  for (const m of mins) {
    if (naming("cancel_departure", m).length) continue;
    // ponytail: several shifts on one departure → the last one listed wins
    const shiftedMin = naming("shift_minutes", m).at(-1)?.minutes ?? 0;
    out.push({ serviceId: service.id, date, at: at(m + shiftedMin), planned: toHHMM(m), shiftedMin, added: false });
  }
  for (const e of mine)
    if (e.type === "add_departure" && e.departure !== null)
      out.push({
        serviceId: service.id,
        date,
        at: at(onServiceDay(e.departure)),
        planned: e.departure,
        shiftedMin: 0,
        added: true,
      });
  return out.sort((a, b) => a.at - b.at);
}
