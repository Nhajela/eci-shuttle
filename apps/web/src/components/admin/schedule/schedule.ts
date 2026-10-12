/** admin-schedule: pure helpers for the schedule page (form → service input, plain-English labels, IST dates). */
import {
  type Departure,
  type ExceptionKind,
  formatIst,
  type HHMM,
  type IsoDate,
  istHHMM,
  istToEpoch,
  type ServicePattern,
} from "@eci-shuttle/shared";

const DAY_MS = 86_400_000;
const utcDay = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`);

export const addDays = (d: IsoDate, n: number): IsoDate => new Date(utcDay(d) + n * DAY_MS).toISOString().slice(0, 10);

/** The Monday of the IST week containing `d`. */
export const weekStart = (d: IsoDate): IsoDate => addDays(d, -((new Date(utcDay(d)).getUTCDay() + 6) % 7));

export const weekDays = (start: IsoDate): IsoDate[] => Array.from({ length: 7 }, (_, i) => addDays(start, i));

/** "Mon 12 Oct" */
export const dayLabel = (d: IsoDate): string => formatIst(istToEpoch(d, "12:00")).split(",")[0];

export function describePattern(p: ServicePattern): string {
  if (p.kind === "every") return `every ${p.everyMin} min`;
  if (p.kind === "times") return `at ${p.times.join(", ")}`;
  return "continuous loop";
}

export function describeException(e: {
  kind: ExceptionKind;
  departure: string | null;
  minutes: number | null;
}): string {
  switch (e.kind) {
    case "cancel_day":
      return "Whole day cancelled";
    case "cancel_departure":
      return `${e.departure} cancelled`;
    case "add_departure":
      return `${e.departure} added`;
    case "shift_minutes":
      return `${e.departure} moved ${(e.minutes ?? 0) > 0 ? "+" : ""}${e.minutes} min`;
  }
}

export function departureLabel(d: Departure): string {
  const at = istHHMM(d.at);
  if (d.added) return `${at} (added)`;
  return d.shiftedMin ? `${at} (was ${d.planned})` : at;
}

/** "9:40, 07:00" → ["07:00", "09:40"]. Tokens that aren't H:MM pass through so the service's validation names them. */
export function parseTimes(text: string): string[] {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const norm = tokens.map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  return [...new Set(norm)].sort();
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const orNull = (s: string) => (s === "" ? null : s);

/** The service form's fields as ServiceCreateFields (also used for updates). */
export function serviceFormToInput(fd: FormData) {
  const patternKind = str(fd, "patternKind");
  const pattern =
    patternKind === "every"
      ? { kind: "every" as const, everyMin: Number(str(fd, "everyMin")) }
      : patternKind === "times"
        ? { kind: "times" as const, times: parseTimes(str(fd, "times")) }
        : { kind: "loop" as const };
  return {
    name: str(fd, "name"),
    kind: str(fd, "kind") as "regular" | "special",
    routeId: str(fd, "routeId"),
    public: fd.get("public") === "on",
    colour: orNull(str(fd, "colour")),
    validFrom: str(fd, "validFrom"),
    validTo: str(fd, "validTo"),
    daysOfWeek: fd.getAll("days").map(Number),
    startTime: str(fd, "startTime"),
    endTime: str(fd, "endTime"),
    pattern,
  };
}

export function exceptionFormToInput(fd: FormData) {
  const minutes = str(fd, "minutes");
  return {
    serviceId: str(fd, "serviceId"),
    date: str(fd, "date"),
    type: str(fd, "type") as ExceptionKind,
    departure: orNull(str(fd, "departure")),
    minutes: minutes === "" ? null : Number(minutes),
    note: orNull(str(fd, "note")),
  };
}

/** IST start/end timestamps for a staffing range on `date`; an end at or before the start is the next day. */
export function assignmentRange(date: IsoDate, start: HHMM, end: HHMM) {
  const endDate = end <= start ? addDays(date, 1) : date;
  return { startsAt: `${date}T${start}:00+05:30`, endsAt: `${endDate}T${end}:00+05:30` };
}

/** "Mon 12 Oct, 08:00–13:00", or with the end day when it differs. */
export function formatRange(startsAt: Date, endsAt: Date): string {
  const s = formatIst(startsAt);
  const e = formatIst(endsAt);
  return s.split(",")[0] === e.split(",")[0] ? `${s}–${istHHMM(endsAt)}` : `${s} – ${e}`;
}
