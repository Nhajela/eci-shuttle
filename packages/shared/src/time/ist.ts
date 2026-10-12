/** IST (UTC+05:30, no DST) wall-clock helpers. Every time shown to a person goes through these, never toLocale*. */
import { type HHMM, IST_OFFSET_MIN, type IsoDate } from "../contracts/common";

const OFFSET_MS = IST_OFFSET_MIN * 60_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A Date whose UTC fields read as the IST wall clock. */
const shifted = (t: number | Date) => new Date(+t + OFFSET_MS);

/** "YYYY-MM-DD" of the IST calendar day. */
export const istDate = (t: number | Date): IsoDate => shifted(t).toISOString().slice(0, 10);

/** "HH:MM" IST, 24h. */
export const istHHMM = (t: number | Date): HHMM => shifted(t).toISOString().slice(11, 16);

/** ISO weekday in IST: 1 = Monday … 7 = Sunday. */
export const istWeekday = (t: number | Date): number => shifted(t).getUTCDay() || 7;

/** Epoch ms of an IST date + wall-clock time. */
export const istToEpoch = (date: IsoDate, time: HHMM): number => Date.parse(`${date}T${time}:00Z`) - OFFSET_MS;

/** "Mon 12 Oct, 09:40" (IST). */
export function formatIst(t: number | Date): string {
  const d = shifted(t);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${istHHMM(t)}`;
}
