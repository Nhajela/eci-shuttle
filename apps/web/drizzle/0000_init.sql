CREATE TABLE "alert_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kinds" text[] NOT NULL,
	"quiet_from" text,
	"quiet_to" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_prefs_one" UNIQUE("person_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_label" text,
	"channel" text NOT NULL,
	"client" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"proposal_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departure_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"spot_id" uuid NOT NULL,
	"date" date NOT NULL,
	"planned_at" timestamp with time zone NOT NULL,
	"actual_at" timestamp with time zone,
	"dwell_id" uuid,
	"delay_min" real,
	"missed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departure_matches_one" UNIQUE("service_id","spot_id","planned_at")
);
--> statement-breakpoint
CREATE TABLE "device_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"push_token" text,
	"model" text,
	"app_version" text,
	"update_id" text,
	"target_update_id" text,
	"update_failed_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"battery" real,
	"charging" boolean,
	"permissions" jsonb,
	"reported_mode" text,
	"reported_config_version" integer,
	"config_version" integer DEFAULT 1 NOT NULL,
	"clock_skew_ms" integer,
	"killed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"permission_lost_since" timestamp with time zone,
	"low_battery_since" timestamp with time zone,
	"simulated" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid,
	"vehicle_id" uuid,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"interval_s" integer,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directives_one_target" CHECK (("directives"."device_id" is null) <> ("directives"."vehicle_id" is null))
);
--> statement-breakpoint
CREATE TABLE "dwells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"spot_id" uuid NOT NULL,
	"service_id" uuid,
	"arrived_at" timestamp with time zone NOT NULL,
	"departed_at" timestamp with time zone,
	"planned_departure_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "learning_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"service_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_exclusions_one" UNIQUE NULLS NOT DISTINCT("workspace_id","date","service_id")
);
--> statement-breakpoint
CREATE TABLE "leg_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_spot_id" uuid NOT NULL,
	"to_spot_id" uuid,
	"service_id" uuid,
	"hour_bucket" integer,
	"n" integer NOT NULL,
	"median_s" real NOT NULL,
	"p20_s" real NOT NULL,
	"p80_s" real NOT NULL,
	"level" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leg_stats_key" UNIQUE NULLS NOT DISTINCT("workspace_id","kind","from_spot_id","to_spot_id","service_id","hour_bucket")
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"telegram_id" bigint,
	"username" text,
	"first_name" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"client" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_one" UNIQUE("person_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"placements" text[] NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"sent_at" timestamp with time zone,
	"group_message_id" bigint,
	"unpinned_at" timestamp with time zone,
	"created_by_person_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text,
	"created_by_person_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"blocked_bot_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "pings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy" real NOT NULL,
	"speed" real,
	"heading" real,
	"battery" real,
	CONSTRAINT "pings_device_recorded" UNIQUE("device_id","recorded_at")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"versions" jsonb NOT NULL,
	"summary" text NOT NULL,
	"reason" text,
	"client" text,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"spot_ids" uuid[] NOT NULL,
	"path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"path_source" text DEFAULT 'straight' NOT NULL,
	"spot_path_idx" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"typical_leg_s" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"planned_dwell_s" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_speeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"start_m" real NOT NULL,
	"end_m" real NOT NULL,
	"hour_bucket" integer,
	"n" integer NOT NULL,
	"median_mps" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_speeds_key" UNIQUE NULLS NOT DISTINCT("route_id","segment_index","hour_bucket")
);
--> statement-breakpoint
CREATE TABLE "service_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"departure" text,
	"minutes" integer,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_exceptions_one" UNIQUE NULLS NOT DISTINCT("service_id","date","kind","departure")
);
--> statement-breakpoint
CREATE TABLE "service_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_vehicles_range" CHECK ("service_vehicles"."ends_at" > "service_vehicles"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"route_id" uuid NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"colour" text,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"pattern" jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_m" integer DEFAULT 75 NOT NULL,
	"notes" text,
	"photo_url" text,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"spot_id" uuid,
	"service_id" uuid,
	"lead_min" integer,
	"expires_at" timestamp with time zone,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"proposed_changes" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"proposal_id" text,
	"decided_at" timestamp with time zone,
	"decided_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_dedupe" UNIQUE("workspace_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"chat_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"ok" boolean NOT NULL,
	"message_id" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"service_id" uuid,
	"route_id" uuid,
	"from_spot_id" uuid NOT NULL,
	"to_spot_id" uuid,
	"departed_at" timestamp with time zone NOT NULL,
	"arrived_at" timestamp with time zone,
	"duration_s" integer,
	"quality" text DEFAULT 'clean' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_state" (
	"vehicle_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"service_id" uuid,
	"phase" text DEFAULT 'off_duty' NOT NULL,
	"spot_id" uuid,
	"next_spot_id" uuid,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"eta_s" integer,
	"last_ping_at" timestamp with time zone,
	"lat" double precision,
	"lng" double precision,
	"along_m" real,
	"off_route" boolean DEFAULT false NOT NULL,
	"off_route_since" timestamp with time zone,
	"geofence" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"plate" text,
	"colour" text,
	"capacity" integer,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"target_update_id" text,
	"min_app_version" text,
	"apk_url" text,
	"active_interval_s" integer DEFAULT 10 NOT NULL,
	"idle_heartbeat_s" integer DEFAULT 900 NOT NULL,
	"group_chat_id" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "alert_prefs" ADD CONSTRAINT "alert_prefs_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_prefs" ADD CONSTRAINT "alert_prefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_matches" ADD CONSTRAINT "departure_matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_matches" ADD CONSTRAINT "departure_matches_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_matches" ADD CONSTRAINT "departure_matches_spot_id_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_matches" ADD CONSTRAINT "departure_matches_dwell_id_dwells_id_fk" FOREIGN KEY ("dwell_id") REFERENCES "public"."dwells"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dwells" ADD CONSTRAINT "dwells_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dwells" ADD CONSTRAINT "dwells_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dwells" ADD CONSTRAINT "dwells_spot_id_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dwells" ADD CONSTRAINT "dwells_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_exclusions" ADD CONSTRAINT "learning_exclusions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_exclusions" ADD CONSTRAINT "learning_exclusions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_stats" ADD CONSTRAINT "leg_stats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_stats" ADD CONSTRAINT "leg_stats_from_spot_id_spots_id_fk" FOREIGN KEY ("from_spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_stats" ADD CONSTRAINT "leg_stats_to_spot_id_spots_id_fk" FOREIGN KEY ("to_spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_stats" ADD CONSTRAINT "leg_stats_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pings" ADD CONSTRAINT "pings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pings" ADD CONSTRAINT "pings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pings" ADD CONSTRAINT "pings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_speeds" ADD CONSTRAINT "segment_speeds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_speeds" ADD CONSTRAINT "segment_speeds_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_exceptions" ADD CONSTRAINT "service_exceptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_exceptions" ADD CONSTRAINT "service_exceptions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_vehicles" ADD CONSTRAINT "service_vehicles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_vehicles" ADD CONSTRAINT "service_vehicles_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_vehicles" ADD CONSTRAINT "service_vehicles_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spots" ADD CONSTRAINT "spots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_spot_id_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_from_spot_id_spots_id_fk" FOREIGN KEY ("from_spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_to_spot_id_spots_id_fk" FOREIGN KEY ("to_spot_id") REFERENCES "public"."spots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_spot_id_spots_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_next_spot_id_spots_id_fk" FOREIGN KEY ("next_spot_id") REFERENCES "public"."spots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_ws_at" ON "audit_log" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_entity" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_proposal" ON "audit_log" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "departure_matches_date" ON "departure_matches" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_open_device" ON "device_assignments" USING btree ("device_id") WHERE "device_assignments"."ends_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_open_vehicle" ON "device_assignments" USING btree ("vehicle_id") WHERE "device_assignments"."ends_at" is null;--> statement-breakpoint
CREATE INDEX "device_assignments_vehicle" ON "device_assignments" USING btree ("vehicle_id","starts_at");--> statement-breakpoint
CREATE INDEX "devices_ws" ON "devices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "directives_device" ON "directives" USING btree ("device_id","ends_at");--> statement-breakpoint
CREATE INDEX "directives_vehicle" ON "directives" USING btree ("vehicle_id","ends_at");--> statement-breakpoint
CREATE INDEX "dwells_vehicle" ON "dwells" USING btree ("vehicle_id","arrived_at");--> statement-breakpoint
CREATE INDEX "dwells_spot" ON "dwells" USING btree ("spot_id","arrived_at");--> statement-breakpoint
CREATE INDEX "login_codes_created" ON "login_codes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_tokens_person" ON "mcp_tokens" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "notices_ws_active" ON "notices" USING btree ("workspace_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("run_after") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "pairing_codes_expires" ON "pairing_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pings_vehicle_recorded" ON "pings" USING btree ("vehicle_id","recorded_at");--> statement-breakpoint
CREATE INDEX "proposals_expires" ON "proposals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "routes_ws" ON "routes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "service_exceptions_service_date" ON "service_exceptions" USING btree ("service_id","date");--> statement-breakpoint
CREATE INDEX "service_vehicles_service" ON "service_vehicles" USING btree ("service_id","starts_at");--> statement-breakpoint
CREATE INDEX "service_vehicles_vehicle" ON "service_vehicles" USING btree ("vehicle_id","starts_at");--> statement-breakpoint
CREATE INDEX "services_ws" ON "services" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "services_route" ON "services" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "spots_ws" ON "spots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "subscriptions_open" ON "subscriptions" USING btree ("workspace_id","kind","spot_id") WHERE "subscriptions"."fired_at" is null and "subscriptions"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "telegram_messages_chat" ON "telegram_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "trips_vehicle" ON "trips" USING btree ("vehicle_id","departed_at");--> statement-breakpoint
CREATE INDEX "trips_leg" ON "trips" USING btree ("from_spot_id","to_spot_id","departed_at");--> statement-breakpoint
CREATE INDEX "vehicles_ws" ON "vehicles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_one_live" ON "workspaces" USING btree ("is_live") WHERE "workspaces"."is_live";