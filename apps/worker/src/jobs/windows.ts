import { notImplemented } from "@eci-shuttle/shared";
import type { Job } from "../job";

/**
 * Every minute (SPEC §2b): service windows opening and closing. For each workspace, vehicles whose tracking
 * window (trackingWindows over service_vehicles ±15 min, plus directives) opened or closed in the last minute:
 * devices/config.bumpConfigs for their phones (config bump + push "sync now") and ingest.refreshPhases (on/off
 * duty). Phones also switch on their own (resolveMode on the stored config); this makes the server side and
 * phones without a fresh config catch up.
 */
export const windows: Job = {
  name: "windows",
  schedule: "* * * * *",
  run: (ctx) => notImplemented(ctx),
};
