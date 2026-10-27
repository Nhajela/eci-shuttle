/**
 * svc-public: which service days are in play right now, shared by the text (status.ts) and the map (positions.ts) so
 * the two cannot disagree: today, plus yesterday's for a cross-midnight service still inside its window. A day
 * counts only inside the service's validity and weekdays and when it has no `cancel_day` exception. Pure.
 */
import { istDate, istToEpoch } from "@eci-shuttle/shared";
import type { Service } from "@/db/types";

const DAY = 86_400_000;

export const addDays = (date: string, n: number) => istDate(istToEpoch(date, "00:00") + n * DAY);
/** ISO weekday of an IST date string, Monday = 1 … Sunday = 7 */
export const weekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export type ServiceDay = { svc: Service; day: string; windowStart: number; windowEnd: number };

/** Just what the selection needs from an exception row (a `ServiceExceptionDef` fits). */
export type DayException = { serviceId: string; date: string; type: string };

export function serviceDaysInPlay(svcs: Service[], exceptions: DayException[], nowMs: number): ServiceDay[] {
  const today = istDate(nowMs);
  const yesterday = addDays(today, -1);
  const days: ServiceDay[] = [];
  for (const svc of svcs) {
    for (const day of [yesterday, today]) {
      const windowStart = istToEpoch(day, svc.startTime);
      const windowEnd = istToEpoch(svc.endTime < svc.startTime ? addDays(day, 1) : day, svc.endTime);
      const runs =
        day >= svc.validFrom &&
        day <= svc.validTo &&
        svc.daysOfWeek.includes(weekday(day)) &&
        !exceptions.some((e) => e.serviceId === svc.id && e.date === day && e.type === "cancel_day");
      if (runs && (day === today || nowMs < windowEnd)) days.push({ svc, day, windowStart, windowEnd });
    }
  }
  return days.sort((a, b) => a.windowStart - b.windowStart);
}
