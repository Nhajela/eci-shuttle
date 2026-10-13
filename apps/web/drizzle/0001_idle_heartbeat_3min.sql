ALTER TABLE "workspaces" ALTER COLUMN "idle_heartbeat_s" SET DEFAULT 180;--> statement-breakpoint
UPDATE "workspaces" SET "idle_heartbeat_s" = 180, "version" = "version" + 1 WHERE "idle_heartbeat_s" = 900;
