import { z } from "zod";

/** Phone tracking mode (SPEC §4). `unpaired` = no device token on the phone. */
export const Mode = z.enum(["active", "idle", "killed", "revoked", "unpaired"]);
export type Mode = z.infer<typeof Mode>;

/** Vehicle phase, derived on ingest (SPEC §3 vehicle_state). */
export const Phase = z.enum(["at_spot", "en_route", "offline", "off_duty"]);
export type Phase = z.infer<typeof Phase>;

/** Per-workspace role. Order matters: viewer < ops < admin (SPEC §7a). */
export const Role = z.enum(["viewer", "ops", "admin"]);
export type Role = z.infer<typeof Role>;
export const ROLE_RANK: Record<Role, number> = { viewer: 0, ops: 1, admin: 2 };

/** attendee = a person using the bot without a role (subscriptions); admin = a person acting with a role. */
export const ActorKind = z.enum(["admin", "device", "system", "attendee"]);
export type ActorKind = z.infer<typeof ActorKind>;

/** Which adapter a call came through. Stored on every audit row. */
export const ActorChannel = z.enum(["web", "mcp", "device", "telegram", "watchdog", "worker"]);
export type ActorChannel = z.infer<typeof ActorChannel>;

export const NoticeSeverity = z.enum(["info", "heads_up", "urgent"]);
export type NoticeSeverity = z.infer<typeof NoticeSeverity>;
/** Display order: urgent first. */
export const SEVERITY_RANK: Record<NoticeSeverity, number> = { urgent: 0, heads_up: 1, info: 2 };

/**
 * Where a notice shows (SPEC §6b). Stored as text[] in `notices.placements`.
 * `spot:<uuid>` / `service:<uuid>` reference a spot or service in the same workspace.
 */
export const NoticePlacement = z.union([
  z.literal("everywhere"),
  z.literal("schedule"),
  z.literal("admin"),
  z.templateLiteral(["spot:", z.uuid()]),
  z.templateLiteral(["service:", z.uuid()]),
]);
export type NoticePlacement = z.infer<typeof NoticePlacement>;

/** Delivery on top of the page: Telegram subscribers of the placed spots, the main group, or the group + pin. */
export const NoticeChannel = z.enum(["subscribers", "group", "group_pin"]);
export type NoticeChannel = z.infer<typeof NoticeChannel>;

export const ServiceKind = z.enum(["regular", "special"]);
export type ServiceKind = z.infer<typeof ServiceKind>;

export const ExceptionKind = z.enum(["cancel_day", "cancel_departure", "add_departure", "shift_minutes"]);
export type ExceptionKind = z.infer<typeof ExceptionKind>;

export const DirectiveKind = z.enum(["active_window", "silence_until", "force_active"]);
export type DirectiveKind = z.infer<typeof DirectiveKind>;

export const TripQuality = z.enum(["clean", "off_route", "gap"]);
export type TripQuality = z.infer<typeof TripQuality>;

export const SuggestionStatus = z.enum(["open", "accepted", "dismissed"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const SubscriptionKind = z.enum(["arrival_alert", "notices", "updates"]);
export type SubscriptionKind = z.infer<typeof SubscriptionKind>;

/** How a public answer line was produced (SPEC §6). */
export const AnswerKind = z.enum(["live", "timetable", "none"]);
export type AnswerKind = z.infer<typeof AnswerKind>;

/** Where a route path came from. */
export const PathSource = z.enum(["osrm", "straight", "manual"]);
export type PathSource = z.infer<typeof PathSource>;

/** Ops alert kinds an admin can opt into (alert_prefs.kinds, SPEC §6c). */
export const AlertKind = z.enum([
  "silent",
  "off_route",
  "low_battery",
  "permission_lost",
  "mode_mismatch",
  "kill_resume",
  "update_failed",
  "admin_changes",
  "digest",
]);
export type AlertKind = z.infer<typeof AlertKind>;

/** Fallback level of a learned estimate (SPEC §6a "ladder"). */
export const EstimateLevel = z.enum(["leg_hour", "leg_day", "baseline"]);
export type EstimateLevel = z.infer<typeof EstimateLevel>;

/** Location permission as the phone reports it. */
export const LocationPermission = z.enum(["always", "foreground", "denied"]);
export type LocationPermission = z.infer<typeof LocationPermission>;

/** Outbox job kinds drained by the worker `queue` job. */
export const OutboxKind = z.enum(["telegram", "push"]);
export type OutboxKind = z.infer<typeof OutboxKind>;
