import { z } from "zod";

/** All row ids are uuids, except pings / audit_log / outbox (bigserial). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Epoch milliseconds. Used everywhere in the device protocol and in pure functions ("now"). */
export const EpochMs = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMs>;

/** Wall-clock time in IST, "HH:MM" 24h. "24:00" is not allowed; cross-midnight is expressed as end < start. */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h, IST)");
export type HHMM = z.infer<typeof HHMM>;

/** A calendar date in IST, "YYYY-MM-DD". A service day is named by the IST date it starts on. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** ISO 8601 timestamp with offset, for HTTP JSON outside the device protocol. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;

/** Hex colour for vehicles, services, notices. */
export const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type Colour = z.infer<typeof Colour>;

/** ISO weekday: 1 = Monday … 7 = Sunday, evaluated in IST. */
export const Weekday = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof Weekday>;

/** Optimistic-concurrency version carried by every editable row (MCP propose/confirm, SPEC §7a). */
export const Version = z.number().int().positive();
export type Version = z.infer<typeof Version>;

/** Timezone of every displayed time. India has no DST, so the offset is fixed. */
export const IST_TZ = "Asia/Kolkata";
export const IST_OFFSET_MIN = 330;
