/**
 * Write inputs, defined once. `*Fields` schemas are workspace-free: MCP change kinds embed them as-is
 * (the proposal carries the workspace). Service functions take `withWorkspace(*Fields)`, i.e. the same
 * fields plus `workspaceId`.
 *
 * `version` on update inputs is optional optimistic concurrency: when given and it doesn't match the row,
 * the service throws STALE_VERSION. MCP confirm checks versions itself from the proposal.
 */
import { z } from "zod";
import { Colour, HHMM, Id, IsoDate, IsoDateTime, LatLng, Version, Weekday } from "./common";
import { ExceptionKind, NoticeChannel, NoticePlacement, NoticeSeverity, ServiceKind } from "./enums";

export const withWorkspace = <T extends z.ZodRawShape>(s: z.ZodObject<T>) => s.extend({ workspaceId: Id });

const name = z.string().trim().min(1).max(100);
const note = z.string().trim().max(1000);

// ---------- workspaces ----------
export const WorkspaceCreateFields = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,30}$/)
    .refine((s) => s !== "admin" && s !== "api" && s !== "w", "reserved slug"),
  name,
});

// ---------- spots ----------
export const SpotCreateFields = z.object({
  name,
  shortName: z.string().trim().min(1).max(24),
  lat: LatLng.shape.lat,
  lng: LatLng.shape.lng,
  radiusM: z.number().int().min(10).max(1000).default(75),
  notes: note.nullable().default(null),
  photoUrl: z.string().url().nullable().default(null),
});
export const SpotUpdateFields = z.object({
  spotId: Id,
  version: Version.optional(),
  name: name.optional(),
  shortName: z.string().trim().min(1).max(24).optional(),
  lat: LatLng.shape.lat.optional(),
  lng: LatLng.shape.lng.optional(),
  radiusM: z.number().int().min(10).max(1000).optional(),
  notes: note.nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
});
export const SpotArchiveFields = z.object({ spotId: Id, version: Version.optional() });

// ---------- routes ----------
export const RouteCreateFields = z.object({
  name,
  /** ordered; first == last for a loop such as Riva → Circle → Riva */
  spotIds: z.array(Id).min(2).max(20),
});
export const RouteUpdateFields = z.object({
  routeId: Id,
  version: Version.optional(),
  name: name.optional(),
  spotIds: z.array(Id).min(2).max(20).optional(),
  /** a hand-edited path; replaces the generated one */
  path: z.array(LatLng).min(2).max(5000).optional(),
  /** regenerate from the routing API (OSRM, falling back to straight segments) */
  regeneratePath: z.boolean().optional(),
  /**
   * Planned wait at stops, in seconds, replacing the whole plan: "*" = every stop, a spot id = that stop
   * (overrides "*"). E.g. {"*": 300} = wait 5 min at each stop; {} = no plan. Learned dwells win once they
   * have enough samples.
   */
  plannedDwellS: z
    .record(
      z.string().refine((k) => k === "*" || Id.safeParse(k).success, "a spot id or *"),
      z.number().int().min(0).max(3600),
    )
    .optional(),
});

// ---------- services ----------
/** Departure pattern of a service, in IST wall-clock times. */
export const ServicePattern = z.discriminatedUnion("kind", [
  /** every N minutes from start_time while < end_time */
  z.object({ kind: z.literal("every"), everyMin: z.number().int().min(5).max(240) }),
  /** explicit departure times (from the route's first spot) */
  z.object({ kind: z.literal("times"), times: z.array(HHMM).min(1).max(100) }),
  /** continuous loop, no fixed times: the schedule shows "about every N min" from the measured cycle */
  z.object({ kind: z.literal("loop") }),
]);
export type ServicePattern = z.infer<typeof ServicePattern>;

export const ServiceCreateFields = z.object({
  name,
  kind: ServiceKind,
  routeId: Id,
  public: z.boolean().default(true),
  colour: Colour.nullable().default(null),
  validFrom: IsoDate,
  validTo: IsoDate,
  daysOfWeek: z.array(Weekday).min(1).max(7),
  startTime: HHMM,
  /** end < start means the service runs past midnight into the next IST day */
  endTime: HHMM,
  pattern: ServicePattern,
});
export const ServiceUpdateFields = z.object({
  serviceId: Id,
  version: Version.optional(),
  name: name.optional(),
  kind: ServiceKind.optional(),
  routeId: Id.optional(),
  public: z.boolean().optional(),
  colour: Colour.nullable().optional(),
  validFrom: IsoDate.optional(),
  validTo: IsoDate.optional(),
  daysOfWeek: z.array(Weekday).min(1).max(7).optional(),
  startTime: HHMM.optional(),
  endTime: HHMM.optional(),
  pattern: ServicePattern.optional(),
});

/**
 * One-day edit (SPEC §3 service_exceptions). `date` is the IST service day.
 * cancel_day: no departure. cancel_departure / add_departure: `departure` required.
 * shift_minutes: `departure` and `minutes` (non-zero, ±180) required.
 */
export const ServiceExceptionFields = z.object({
  serviceId: Id,
  date: IsoDate,
  type: ExceptionKind,
  departure: HHMM.nullable().default(null),
  minutes: z.number().int().min(-180).max(180).nullable().default(null),
  note: note.nullable().default(null),
});
export const checkException = (e: z.infer<typeof ServiceExceptionFields>, ctx: z.RefinementCtx) => {
  if (e.type !== "cancel_day" && !e.departure) ctx.addIssue({ code: "custom", message: "departure is required" });
  if (e.type === "shift_minutes" && !e.minutes) ctx.addIssue({ code: "custom", message: "minutes is required" });
};

export const ServiceVehicleAssignFields = z.object({
  serviceId: Id,
  vehicleId: Id,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
});
export const ServiceVehicleUnassignFields = z.object({ serviceVehicleId: Id });

// ---------- vehicles ----------
export const VehicleCreateFields = z.object({
  name,
  plate: z.string().trim().max(20).nullable().default(null),
  colour: Colour.nullable().default(null),
  capacity: z.number().int().min(1).max(100).nullable().default(null),
  active: z.boolean().default(true),
});
export const VehicleUpdateFields = z.object({
  vehicleId: Id,
  version: Version.optional(),
  name: name.optional(),
  plate: z.string().trim().max(20).nullable().optional(),
  colour: Colour.nullable().optional(),
  capacity: z.number().int().min(1).max(100).nullable().optional(),
  active: z.boolean().optional(),
});

// ---------- phones (devices) ----------
export const PhoneLabelFields = z.object({ deviceId: Id, label: name });
/** vehicleId null = unassign. Closes the open assignment and opens a new one. */
export const PhoneAssignFields = z.object({ deviceId: Id, vehicleId: Id.nullable() });
export const PhoneSilenceFields = z.object({ deviceId: Id, until: IsoDateTime });
export const PhoneForceActiveFields = z.object({
  deviceId: Id,
  until: IsoDateTime,
  intervalS: z.number().int().min(5).max(600).nullable().default(null),
});
export const PhoneNudgeFields = z.object({ deviceId: Id });
export const PhoneKillFields = z.object({ deviceId: Id });
export const PhoneRevokeFields = z.object({ deviceId: Id });
export const PhoneMoveWorkspaceFields = z.object({ deviceId: Id, toWorkspaceId: Id });
export const PairingCodeCreateFields = z.object({ label: name.nullable().default(null) });

// ---------- OTA app updates (SPEC §5) ----------
/** an expo-updates update id */
const UpdateId = z.string().trim().min(1).max(100);
/** the workspace target; null = stop targeting (phones keep what they run) */
export const OtaRolloutFields = z.object({ updateId: UpdateId.nullable() });
/** target the update from before the last rollout again */
export const OtaRollbackFields = z.object({});
/** per-phone override; null = follow the workspace target again */
export const OtaPhoneFields = z.object({ deviceId: Id, updateId: UpdateId.nullable() });

// ---------- notices ----------
export const NoticeCreateFields = z.object({
  text: z.string().trim().min(1).max(1000),
  severity: NoticeSeverity.default("info"),
  pinned: z.boolean().default(false),
  sort: z.number().int().default(0),
  /** null = now */
  startsAt: IsoDateTime.nullable().default(null),
  /** null = until ended by hand */
  endsAt: IsoDateTime.nullable().default(null),
  placements: z.array(NoticePlacement).min(1).max(20),
  channels: z.array(NoticeChannel).max(3).default([]),
});
export const NoticeEndFields = z.object({ noticeId: Id });
