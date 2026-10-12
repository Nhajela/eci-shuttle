/**
 * GET /api/status?w=<slug> (and the public page, the bot's /shuttle and MCP shuttle_public_answer).
 * Attendees never see lateness: no "late", no planned-vs-expected, only predicted arrival (SPEC §6a.2).
 */
import { z } from "zod";
import { Colour, HHMM, Id, IsoDateTime } from "./common";
import { AnswerKind, NoticeSeverity } from "./enums";

export const PublicNotice = z.object({
  id: Id,
  text: z.string(),
  severity: NoticeSeverity,
  pinned: z.boolean(),
  endsAt: IsoDateTime.nullable(),
});
export type PublicNotice = z.infer<typeof PublicNotice>;

/** One line per public service serving the spot: "To Circle: 6 min" · "Party shuttle: 22:00". */
export const AnswerLine = z.object({
  serviceId: Id,
  serviceName: z.string(),
  colour: Colour.nullable(),
  kind: AnswerKind,
  /** live: predicted minutes until the shuttle is at this spot */
  minutes: z.number().int().nonnegative().nullable(),
  /** live: p20..p80 range in minutes ("5–9") */
  rangeLo: z.number().int().nonnegative().nullable(),
  rangeHi: z.number().int().nonnegative().nullable(),
  /** live and data is thin (<5 samples): UI says "about" */
  approx: z.boolean(),
  /** timetable: next departure from this spot (learned typical time for that slot) */
  nextAt: IsoDateTime.nullable(),
  /** "HH:MM" IST of nextAt, for display */
  nextAtLabel: HHMM.nullable(),
  /** small context line: "leaving Circle now", "live tracking off", "no more shuttles today" */
  phaseText: z.string(),
  /** seconds since the vehicle's last ping; null when not live */
  lastSeenS: z.number().int().nonnegative().nullable(),
  vehicleName: z.string().nullable(),
  notices: z.array(PublicNotice),
});
export type AnswerLine = z.infer<typeof AnswerLine>;

export const ScheduleRow = z.object({
  serviceId: Id,
  serviceName: z.string(),
  /** planned departure from this spot, after today's exceptions */
  at: IsoDateTime,
  label: HHMM,
  past: z.boolean(),
  next: z.boolean(),
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;

export const PublicSpot = z.object({
  spotId: Id,
  name: z.string(),
  shortName: z.string(),
  /** `spot:<id>` notices */
  notices: z.array(PublicNotice),
  answers: z.array(AnswerLine),
  schedule: z.object({
    /** `schedule` notices */
    notices: z.array(PublicNotice),
    rows: z.array(ScheduleRow),
    /** continuous-loop services: "about every 25 min" (SPEC §6a.4) */
    loops: z.array(z.object({ serviceId: Id, serviceName: z.string(), everyMin: z.number().int().positive() })),
  }),
});
export type PublicSpot = z.infer<typeof PublicSpot>;

export const PublicStatus = z.object({
  workspace: z.object({ slug: z.string(), name: z.string(), isLive: z.boolean() }),
  generatedAt: IsoDateTime,
  /** `everywhere` notices */
  notices: z.array(PublicNotice),
  /** spots with a public service running today, in toggle order */
  spots: z.array(PublicSpot),
});
export type PublicStatus = z.infer<typeof PublicStatus>;
