/**
 * Device <-> server protocol (SPEC §4). Desired state + reconcile:
 * the phone uploads what it has and reports what it is doing; the server answers with the full desired config.
 */
import { z } from "zod";
import { EpochMs, Id, Version } from "./common";
import { LocationPermission, Mode } from "./enums";

/** One GPS fix, queued on disk and uploaded in batches. Server dedupes on (device_id, recordedAt). */
export const Ping = z.object({
  recordedAt: EpochMs,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** metres, 1-sigma horizontal accuracy as Android reports it */
  accuracy: z.number().nonnegative(),
  /** m/s; null when the fix has none */
  speed: z.number().nonnegative().nullable(),
  /** degrees 0..360; null when the fix has none */
  heading: z.number().min(0).max(360).nullable(),
  /** 0..100 at the time of the fix */
  battery: z.number().min(0).max(100).nullable(),
});
export type Ping = z.infer<typeof Ping>;

export const Permissions = z.object({
  location: LocationPermission,
  preciseLocation: z.boolean(),
  notifications: z.boolean(),
  batteryOptimizationExempt: z.boolean(),
});
export type Permissions = z.infer<typeof Permissions>;

/**
 * A span of time with a mode the phone should be in. The schedule in a sync response covers the next 48h.
 * - `active` windows come from service_vehicles (service window ±15 min), `active_window` and `force_active` directives.
 * - `idle` windows come from `silence_until` directives and override any overlapping active window.
 */
export const Window = z.object({
  startsAt: EpochMs,
  endsAt: EpochMs,
  mode: z.enum(["active", "idle"]),
  /** GPS interval while active; null = use the config's activeIntervalS */
  intervalS: z.number().int().positive().nullable(),
  source: z.enum(["service", "active_window", "force_active", "silence"]),
  /** Shown in the phone notification, e.g. "Riva ↔ Circle" */
  label: z.string().nullable(),
});
export type Window = z.infer<typeof Window>;

/** POST /api/device/pair */
export const PairRequest = z.object({
  /** 6-digit code typed in, or the code inside the QR */
  code: z.string().trim().min(4).max(64),
  model: z.string().max(200),
  appVersion: z.string().max(50),
  updateId: z.string().max(100).nullable(),
  pushToken: z.string().max(500).nullable(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/** POST /api/device/sync, bearer device token. */
export const SyncRequest = z.object({
  pings: z.array(Ping).max(5000),
  battery: z.number().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
  permissions: Permissions,
  reportedMode: Mode,
  appliedConfigVersion: z.number().int().nonnegative(),
  appVersion: z.string().max(50),
  /** expo-updates update id currently running; null = embedded bundle */
  updateId: z.string().max(100).nullable(),
  /** true when the last OTA attempt crashed and expo-updates fell back */
  updateFailed: z.boolean().optional(),
  pushToken: z.string().max(500).nullable().optional(),
  /** phone clock (epoch ms) when the request was built; server stores the skew */
  clock: EpochMs,
  /** the driver pressed Resume after a kill. Audited with who/when. */
  resume: z.literal(true).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/** The full desired config. The phone stores it on disk and runs resolveMode(config, now) on it. */
export const SyncResponse = z.object({
  configVersion: Version,
  killed: z.boolean(),
  revoked: z.boolean(),
  schedule: z.array(Window),
  activeIntervalS: z.number().int().positive(),
  idleHeartbeatS: z.number().int().positive(),
  /** below this app version the phone shows "New version: tap to install" */
  minAppVersion: z.string().nullable(),
  /** where to download the APK for minAppVersion */
  apkUrl: z.string().url().nullable(),
  /** OTA update this phone should run; null = keep what it runs */
  targetUpdateId: z.string().nullable(),
  /** origin to use for the next sync (host-portable, SPEC §2a); the phone keeps the previous one as fallback */
  apiOrigin: z.string().url(),
  serverTime: EpochMs,
  /** shown on the phone's home screen */
  vehicleName: z.string().nullable(),
  workspace: z.object({ slug: z.string(), isLive: z.boolean() }),
});
export type SyncResponse = z.infer<typeof SyncResponse>;

export const PairResponse = z.object({
  deviceId: Id,
  /** bearer token; stored hashed on the server, shown exactly once */
  token: z.string(),
  config: SyncResponse,
});
export type PairResponse = z.infer<typeof PairResponse>;

/** What resolveMode needs: the stored config, or null when the phone isn't paired. */
export type DeviceConfig = Pick<
  SyncResponse,
  "configVersion" | "killed" | "revoked" | "schedule" | "activeIntervalS" | "idleHeartbeatS"
>;

/** resolveMode's answer: what to do right now, and until when (for "Sharing location until 11:00"). */
export type ModeResolution = {
  mode: Mode;
  /** GPS interval for active, heartbeat interval for idle, null for killed/revoked/unpaired */
  intervalS: number | null;
  /** when the mode next changes per the schedule; null when it won't within the schedule */
  until: number | null;
  /** the window making the phone active (or idle for silence), if any */
  window: Window | null;
  /** the next window that will change the mode, if any */
  next: Window | null;
};
