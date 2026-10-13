/**
 * The whole database (SPEC §3, §6a, §6b, §6c, §7a). FROZEN for the parallel build: changes go through
 * docs/CONTRACTS.md "contract change requests", never a module's own edit.
 *
 * Conventions
 * - Every domain row carries workspace_id (cascade delete with the workspace). Global identity/infra rows
 *   (people, login_codes, mcp_tokens, worker_heartbeat) don't; telegram_messages / audit_log / outbox have a
 *   nullable one.
 * - Ids are uuid, except high-volume append-only tables (pings, audit_log, outbox, telegram_messages): bigserial.
 * - Every admin-editable row has `version` (optimistic concurrency, MCP propose/confirm). Services bump it.
 * - Timestamps are timestamptz. IST wall-clock times ("HH:MM") and IST dates are text / date columns.
 * - Enum-like columns are text typed with the zod enums from @eci-shuttle/shared (no pg enums: no ALTER TYPE).
 */
import type {
  AlertKind,
  DirectiveKind,
  EstimateLevel,
  ExceptionKind,
  GeofenceState,
  LatLng,
  McpChange,
  Mode,
  NoticeChannel,
  NoticePlacement,
  NoticeSeverity,
  OutboxKind,
  PathSource,
  Permissions,
  Phase,
  Role,
  ServiceKind,
  ServicePattern,
  SubscriptionKind,
  SuggestionStatus,
  TripQuality,
} from "@eci-shuttle/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
// $onUpdate covers raw `.update()`s that forget it; services still pass their own `now`
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
/** integer[] whose NULL elements read back as null: postgres-js parses them as +"NULL" = NaN */
const nullableIntArray = customType<{ data: (number | null)[]; driverData: string | number[] }>({
  dataType: () => "integer[]",
  toDriver: (v) => `{${v.map((x) => x ?? "NULL").join(",")}}`,
  fromDriver: (v) => (v as number[]).map((x) => (Number.isNaN(x) ? null : x)),
});
const version = () => integer("version").notNull().default(1);
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ============================================================ workspaces (§3)

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /** exactly one live workspace serves `/` */
    isLive: boolean("is_live").notNull().default(false),
    /** OTA (§5): the EAS update every phone in this workspace should run; a device row can override it */
    targetUpdateId: text("target_update_id"),
    /** phones below this app version are told "New version: tap to install" */
    minAppVersion: text("min_app_version"),
    apkUrl: text("apk_url"),
    /** defaults for the device config */
    activeIntervalS: integer("active_interval_s").notNull().default(10),
    idleHeartbeatS: integer("idle_heartbeat_s").notNull().default(180),
    /** Telegram group for notices (§6b channels) and ops alerts chat, per workspace so test never reaches real ops */
    groupChatId: bigint("group_chat_id", { mode: "number" }),
    /** daily ops tracking hours, IST HH:MM (both or neither): assigned phones track off duty, positions ops-only */
    opsHoursStart: text("ops_hours_start"),
    opsHoursEnd: text("ops_hours_end"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspaces_one_live").on(t.isLive).where(sql`${t.isLive}`)],
);

// ============================================================ phones, vehicles, places (§3)

export const devices = pgTable(
  "devices",
  {
    id: id(),
    workspaceId: workspaceId(),
    label: text("label").notNull(),
    /** sha256 of the bearer token; the token itself is only ever shown once at pairing */
    tokenHash: text("token_hash").notNull().unique(),
    pushToken: text("push_token"),
    model: text("model"),
    appVersion: text("app_version"),
    /** expo-updates id the phone runs (null = embedded bundle) */
    updateId: text("update_id"),
    /** per-phone OTA override of workspaces.target_update_id */
    targetUpdateId: text("target_update_id"),
    updateFailedAt: ts("update_failed_at"),
    lastSyncAt: ts("last_sync_at"),
    battery: real("battery"),
    charging: boolean("charging"),
    permissions: jsonb("permissions").$type<Permissions>(),
    reportedMode: text("reported_mode").$type<Mode>(),
    reportedConfigVersion: integer("reported_config_version"),
    /** desired config version; bumped (and a push queued) whenever anything in the device's config changes */
    configVersion: integer("config_version").notNull().default(1),
    /** phone clock − server clock at last sync */
    clockSkewMs: integer("clock_skew_ms"),
    killedAt: ts("killed_at"),
    revokedAt: ts("revoked_at"),
    /** alerts: since when location permission has been missing / the battery low (null = fine) */
    permissionLostSince: ts("permission_lost_since"),
    lowBatterySince: ts("low_battery_since"),
    /** `pnpm sim` device; only allowed in non-live workspaces */
    simulated: boolean("simulated").notNull().default(false),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("devices_ws").on(t.workspaceId)],
);

export const vehicles = pgTable(
  "vehicles",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    plate: text("plate"),
    colour: text("colour"),
    capacity: integer("capacity"),
    active: boolean("active").notNull().default(true),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("vehicles_ws").on(t.workspaceId)],
);

export const spots = pgTable(
  "spots",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    radiusM: integer("radius_m").notNull().default(75),
    notes: text("notes"),
    photoUrl: text("photo_url"),
    archivedAt: ts("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("spots_ws").on(t.workspaceId)],
);

export const routes = pgTable(
  "routes",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    /** ordered spot ids; a loop repeats the first spot at the end */
    spotIds: uuid("spot_ids").array().notNull(),
    path: jsonb("path").$type<LatLng[]>().notNull().default([]),
    pathSource: text("path_source").$type<PathSource>().notNull().default("straight"),
    /** index into path of each spot in spotIds (where each leg starts/ends) */
    spotPathIdx: integer("spot_path_idx").array().notNull().default(sql`'{}'::integer[]`),
    /** learned median per leg (seconds), refreshed by the learning job; null entries = unknown */
    typicalLegS: nullableIntArray("typical_leg_s").notNull().default(sql`'{}'::integer[]`),
    /** planned dwell (seconds) per spot id on this route; a spot without an entry has no planned dwell */
    plannedDwellS: jsonb("planned_dwell_s").$type<Record<string, number>>().notNull().default({}),
    archivedAt: ts("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("routes_ws").on(t.workspaceId)],
);

// ============================================================ schedule (§3)

export const services = pgTable(
  "services",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    kind: text("kind").$type<ServiceKind>().notNull(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id),
    public: boolean("public").notNull().default(true),
    colour: text("colour"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }).notNull(),
    /** ISO weekdays 1 = Mon … 7 = Sun (IST) */
    daysOfWeek: integer("days_of_week").array().notNull(),
    /** "HH:MM" IST; end < start = runs past midnight */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    pattern: jsonb("pattern").$type<ServicePattern>().notNull(),
    archivedAt: ts("archived_at"),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_ws").on(t.workspaceId), index("services_route").on(t.routeId)],
);

export const serviceExceptions = pgTable(
  "service_exceptions",
  {
    id: id(),
    workspaceId: workspaceId(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    /** IST service day */
    date: date("date", { mode: "string" }).notNull(),
    kind: text("kind").$type<ExceptionKind>().notNull(),
    /** "HH:MM": the planned departure cancelled / shifted, or the one added */
    departure: text("departure"),
    minutes: integer("minutes"),
    note: text("note"),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index("service_exceptions_service_date").on(t.serviceId, t.date),
    unique("service_exceptions_one").on(t.serviceId, t.date, t.kind, t.departure).nullsNotDistinct(),
  ],
);

export const serviceVehicles = pgTable(
  "service_vehicles",
  {
    id: id(),
    workspaceId: workspaceId(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    index("service_vehicles_service").on(t.serviceId, t.startsAt),
    index("service_vehicles_vehicle").on(t.vehicleId, t.startsAt),
    check("service_vehicles_range", sql`${t.endsAt} > ${t.startsAt}`),
    // ponytail: no EXCLUDE constraint (drizzle-kit can't emit one, and uuid in gist needs btree_gist). The
    // overlap rule (same vehicle + same service + overlapping range = CONFLICT) is enforced in
    // catalog/schedule.assignServiceVehicle under a row lock; move it here if a second writer appears.
  ],
);

/**
 * A driver's break: the vehicle stays on its service and its phone keeps tracking, but it gives no ETA,
 * doesn't count toward "how many shuttles run" and raises no silent / off-route alert. `endsAt` null = until
 * ended by hand; `endedAt` = ended by hand (early or open-ended).
 */
export const vehicleBreaks = pgTable(
  "vehicle_breaks",
  {
    id: id(),
    workspaceId: workspaceId(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at"),
    endedAt: ts("ended_at"),
    note: text("note"),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [index("vehicle_breaks_vehicle").on(t.vehicleId, t.startsAt)],
);

// ============================================================ notices (§6b)

export const notices = pgTable(
  "notices",
  {
    id: id(),
    workspaceId: workspaceId(),
    text: text("text").notNull(),
    severity: text("severity").$type<NoticeSeverity>().notNull().default("info"),
    pinned: boolean("pinned").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    startsAt: ts("starts_at").notNull().defaultNow(),
    endsAt: ts("ends_at"),
    /** ended by hand before endsAt */
    endedAt: ts("ended_at"),
    placements: text("placements").array().$type<NoticePlacement[]>().notNull(),
    channels: text("channels").array().$type<NoticeChannel[]>().notNull().default(sql`'{}'::text[]`),
    /** set by the notices job once subscribers/group were sent to (so a restart never double-sends) */
    sentAt: ts("sent_at"),
    groupMessageId: bigint("group_message_id", { mode: "number" }),
    unpinnedAt: ts("unpinned_at"),
    createdByPersonId: uuid("created_by_person_id").references(() => people.id),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("notices_ws_active").on(t.workspaceId, t.startsAt, t.endsAt)],
);

// ============================================================ device control (§3, §4)

/** Time-bound phone → vehicle. Reassign = close the open row + open a new one. */
export const deviceAssignments = pgTable(
  "device_assignments",
  {
    id: id(),
    workspaceId: workspaceId(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    startsAt: ts("starts_at").notNull().defaultNow(),
    endsAt: ts("ends_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("device_assignments_open_device").on(t.deviceId).where(sql`${t.endsAt} is null`),
    // a vehicle may hold several open phones (backup sources); a phone is in one vehicle at a time
    index("device_assignments_vehicle").on(t.vehicleId, t.startsAt),
  ],
);

/** Overrides only; default tracking windows come from service_vehicles. Target is a device OR a vehicle. */
export const directives = pgTable(
  "directives",
  {
    id: id(),
    workspaceId: workspaceId(),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "cascade" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DirectiveKind>().notNull(),
    startsAt: ts("starts_at").notNull().defaultNow(),
    endsAt: ts("ends_at").notNull(),
    intervalS: integer("interval_s"),
    cancelledAt: ts("cancelled_at"),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [
    check("directives_one_target", sql`(${t.deviceId} is null) <> (${t.vehicleId} is null)`),
    index("directives_device").on(t.deviceId, t.endsAt),
    index("directives_vehicle").on(t.vehicleId, t.endsAt),
  ],
);

export const pairingCodes = pgTable(
  "pairing_codes",
  {
    /** 6 digits, also inside the QR */
    code: text("code").primaryKey(),
    workspaceId: workspaceId(),
    label: text("label"),
    createdByPersonId: uuid("created_by_person_id").references(() => people.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("pairing_codes_expires").on(t.expiresAt)],
);

// ============================================================ live data (§3, derived, not audited)

export const pings = pgTable(
  "pings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: workspaceId(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** resolved from device_assignments at ingest; null when unassigned */
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    recordedAt: ts("recorded_at").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    accuracy: real("accuracy").notNull(),
    speed: real("speed"),
    heading: real("heading"),
    battery: real("battery"),
  },
  (t) => [
    unique("pings_device_recorded").on(t.deviceId, t.recordedAt),
    index("pings_vehicle_recorded").on(t.vehicleId, t.recordedAt),
  ],
);

export const vehicleState = pgTable("vehicle_state", {
  vehicleId: uuid("vehicle_id")
    .primaryKey()
    .references(() => vehicles.id, { onDelete: "cascade" }),
  workspaceId: workspaceId(),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
  phase: text("phase").$type<Phase>().notNull().default("off_duty"),
  spotId: uuid("spot_id").references(() => spots.id, { onDelete: "set null" }),
  nextSpotId: uuid("next_spot_id").references(() => spots.id, { onDelete: "set null" }),
  since: ts("since").notNull().defaultNow(),
  etaS: integer("eta_s"),
  lastPingAt: ts("last_ping_at"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  /** metres along the current route path */
  alongM: real("along_m"),
  offRoute: boolean("off_route").notNull().default(false),
  /** when the current off-route stretch began (null while on route) */
  offRouteSince: ts("off_route_since"),
  geofence: jsonb("geofence").$type<GeofenceState>(),
  updatedAt: updatedAt(),
});

export const dwells = pgTable(
  "dwells",
  {
    id: id(),
    workspaceId: workspaceId(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    spotId: uuid("spot_id")
      .notNull()
      .references(() => spots.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    arrivedAt: ts("arrived_at").notNull(),
    departedAt: ts("departed_at"),
    /** the planned departure this dwell's departure was matched to */
    plannedDepartureAt: ts("planned_departure_at"),
  },
  (t) => [index("dwells_vehicle").on(t.vehicleId, t.arrivedAt), index("dwells_spot").on(t.spotId, t.arrivedAt)],
);

export const trips = pgTable(
  "trips",
  {
    id: id(),
    workspaceId: workspaceId(),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    routeId: uuid("route_id").references(() => routes.id, { onDelete: "set null" }),
    fromSpotId: uuid("from_spot_id")
      .notNull()
      .references(() => spots.id, { onDelete: "cascade" }),
    toSpotId: uuid("to_spot_id").references(() => spots.id, { onDelete: "cascade" }),
    departedAt: ts("departed_at").notNull(),
    arrivedAt: ts("arrived_at"),
    durationS: integer("duration_s"),
    quality: text("quality").$type<TripQuality>().notNull().default("clean"),
  },
  (t) => [
    index("trips_vehicle").on(t.vehicleId, t.departedAt),
    index("trips_leg").on(t.fromSpotId, t.toSpotId, t.departedAt),
  ],
);

export const departureMatches = pgTable(
  "departure_matches",
  {
    id: id(),
    workspaceId: workspaceId(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    spotId: uuid("spot_id")
      .notNull()
      .references(() => spots.id, { onDelete: "cascade" }),
    /** IST service day */
    date: date("date", { mode: "string" }).notNull(),
    plannedAt: ts("planned_at").notNull(),
    actualAt: ts("actual_at"),
    dwellId: uuid("dwell_id").references(() => dwells.id, { onDelete: "set null" }),
    delayMin: real("delay_min"),
    missed: boolean("missed").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("departure_matches_one").on(t.serviceId, t.spotId, t.plannedAt),
    index("departure_matches_date").on(t.workspaceId, t.date),
  ],
);

// ============================================================ learning (§6a)

/** Leg (from → to) or dwell (at from_spot, to_spot null) duration stats. hour_bucket null = all day. */
export const legStats = pgTable(
  "leg_stats",
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: text("kind").$type<"leg" | "dwell">().notNull(),
    fromSpotId: uuid("from_spot_id")
      .notNull()
      .references(() => spots.id, { onDelete: "cascade" }),
    toSpotId: uuid("to_spot_id").references(() => spots.id, { onDelete: "cascade" }),
    /** special services learn on their own legs; null = all regular services */
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    hourBucket: integer("hour_bucket"),
    n: integer("n").notNull(),
    medianS: real("median_s").notNull(),
    p20S: real("p20_s").notNull(),
    p80S: real("p80_s").notNull(),
    level: text("level").$type<EstimateLevel>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("leg_stats_key")
      .on(t.workspaceId, t.kind, t.fromSpotId, t.toSpotId, t.serviceId, t.hourBucket)
      .nullsNotDistinct(),
  ],
);

export const segmentSpeeds = pgTable(
  "segment_speeds",
  {
    id: id(),
    workspaceId: workspaceId(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id, { onDelete: "cascade" }),
    /** ~200 m segments from the path start */
    segmentIndex: integer("segment_index").notNull(),
    startM: real("start_m").notNull(),
    endM: real("end_m").notNull(),
    hourBucket: integer("hour_bucket"),
    n: integer("n").notNull(),
    medianMps: real("median_mps").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("segment_speeds_key").on(t.routeId, t.segmentIndex, t.hourBucket).nullsNotDistinct()],
);

export const suggestions = pgTable(
  "suggestions",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** e.g. shift_departure, change_frequency, dwell_mismatch */
    kind: text("kind").notNull(),
    /** stable key so the nightly job updates instead of duplicating, e.g. "shift:<service>:<spot>:09:40" */
    dedupeKey: text("dedupe_key").notNull(),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    proposedChanges: jsonb("proposed_changes").$type<McpChange[]>().notNull(),
    status: text("status").$type<SuggestionStatus>().notNull().default("open"),
    proposalId: text("proposal_id"),
    decidedAt: ts("decided_at"),
    decidedByPersonId: uuid("decided_by_person_id").references(() => people.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("suggestions_dedupe").on(t.workspaceId, t.dedupeKey)],
);

/** "Don't learn from this day" (road closure). service_id null = all services that day. */
export const learningExclusions = pgTable(
  "learning_exclusions",
  {
    id: id(),
    workspaceId: workspaceId(),
    date: date("date", { mode: "string" }).notNull(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [unique("learning_exclusions_one").on(t.workspaceId, t.date, t.serviceId).nullsNotDistinct()],
);

// ============================================================ people, roles, Telegram (§6c, §7)

/** Anyone who logged in or messaged the bot. Global (not per workspace). */
export const people = pgTable("people", {
  id: id(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  blockedBotAt: ts("blocked_bot_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    role: text("role").$type<Role>().notNull(),
    version: version(),
    createdAt: createdAt(),
  },
  (t) => [unique("memberships_one").on(t.personId, t.workspaceId)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    workspaceId: workspaceId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SubscriptionKind>().notNull(),
    /** null on a `notices` subscription = all spots */
    spotId: uuid("spot_id").references(() => spots.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    /** arrival_alert: fire when the ETA is ≤ this many minutes */
    leadMin: integer("lead_min"),
    /** arrival_alert: at most 2h after creation */
    expiresAt: ts("expires_at"),
    firedAt: ts("fired_at"),
    cancelledAt: ts("cancelled_at"),
    /** updates: when the last 15-min update went out (worker bookkeeping, not audited) */
    lastSentAt: ts("last_sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("subscriptions_open")
      .on(t.workspaceId, t.kind, t.spotId)
      .where(sql`${t.firedAt} is null and ${t.cancelledAt} is null`),
  ],
);

export const alertPrefs = pgTable(
  "alert_prefs",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    kinds: text("kinds").array().$type<AlertKind[]>().notNull(),
    /** "HH:MM" IST; alerts are held (not dropped) during quiet hours */
    quietFrom: text("quiet_from"),
    quietTo: text("quiet_to"),
    version: version(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("alert_prefs_one").on(t.personId, t.workspaceId)],
);

/** Every Telegram message sent (as Travel CoOp), plus the dev outbox in tests. */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    /** login, alert, notice, broadcast, reply, digest, … */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    ok: boolean("ok").notNull(),
    messageId: bigint("message_id", { mode: "number" }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("telegram_messages_chat").on(t.chatId, t.createdAt)],
);

export const loginCodes = pgTable(
  "login_codes",
  {
    code: text("code").primaryKey(),
    telegramId: bigint("telegram_id", { mode: "number" }),
    username: text("username"),
    firstName: text("first_name"),
    claimedAt: ts("claimed_at"),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_created").on(t.createdAt)],
);

// ============================================================ MCP (§7a)

/** Personal `shs_` tokens and OAuth-issued access tokens. Bound to a person; revocable; listed in admin. */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"personal" | "oauth">().notNull(),
    name: text("name").notNull(),
    /** sha256 of the token */
    tokenHash: text("token_hash").notNull().unique(),
    /** first chars for display ("shs_ab12…") */
    prefix: text("prefix").notNull(),
    /** OAuth client name, e.g. "claude.ai" */
    client: text("client"),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_tokens_person").on(t.personId)],
);

/** MCP proposals: 10 min, bound to one person, carrying the version of every object they touch. */
export const proposals = pgTable(
  "proposals",
  {
    /** the code handed to the model */
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    changes: jsonb("changes").$type<McpChange[]>().notNull(),
    /** "<entity>:<id>" → version at propose time */
    versions: jsonb("versions").$type<Record<string, number>>().notNull(),
    summary: text("summary").notNull(),
    reason: text("reason"),
    client: text("client"),
    expiresAt: ts("expires_at").notNull(),
    confirmedAt: ts("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("proposals_expires").on(t.expiresAt)],
);

// ============================================================ worker, outbox, audit (§2b, §7a)

/** One row per worker process; /api/health fails when the newest beat is > 3 min old. */
export const workerHeartbeat = pgTable("worker_heartbeat", {
  workerId: text("worker_id").primaryKey(),
  beatAt: ts("beat_at").notNull().defaultNow(),
  startedAt: ts("started_at").notNull().defaultNow(),
  info: jsonb("info").$type<Record<string, unknown>>(),
});

/**
 * Side effects queued inside the same transaction as the change that caused them (Telegram sends, push
 * "sync now"), drained by the worker `queue` job with paced retries. dedupe_key makes enqueueing idempotent.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<OutboxKind>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").unique(),
    status: text("status").$type<"pending" | "sent" | "failed" | "dead">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: ts("run_after").notNull().defaultNow(),
    sentAt: ts("sent_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_due").on(t.runAfter).where(sql`${t.status} = 'pending'`)],
);

/** The one audit log. Every mutation writes exactly one row in its own transaction (services/kernel/mutate). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** null only for global entities (people, tokens) */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label"),
    channel: text("channel").notNull(),
    client: text("client"),
    /** dotted verb: spot.create, phone.kill, notice.end … */
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    /** changed fields only (whole row on create/delete) */
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    reason: text("reason"),
    proposalId: text("proposal_id"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_ws_at").on(t.workspaceId, t.at),
    index("audit_log_entity").on(t.entity, t.entityId, t.at),
    index("audit_log_proposal").on(t.proposalId),
  ],
);
