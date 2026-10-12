import type { Departure, IsoDate, ServiceDef, ServiceExceptionDef } from "../contracts";
import { notImplemented } from "../notImplemented";

/**
 * Planned departures (from the route's first spot) of one service on one IST service day, after exceptions,
 * sorted by time. Pure.
 *
 * - Returns [] when `date` is outside validFrom..validTo (inclusive), its IST weekday (1=Mon..7=Sun) isn't in
 *   daysOfWeek, or there is a `cancel_day` exception for that date.
 * - pattern `every`: startTime, startTime+N, … while < endTime. pattern `times`: those times that fall inside
 *   the service window. pattern `loop`: [] (no fixed departures).
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
  return notImplemented(service, exceptions, date);
}
