import type { DeviceConfig, ModeResolution } from "../contracts";
import { notImplemented } from "../notImplemented";

/**
 * What the phone should be doing right now. Runs on the phone (offline too) and on the server (watchdog,
 * "reported ≠ desired"). Pure: `now` is a parameter.
 *
 * - config null → `unpaired` (intervalS null).
 * - config.revoked → `revoked`; else config.killed → `killed` (revoked wins over killed). intervalS null, until null.
 * - an `idle` window (silence) covering now → `idle` with intervalS = idleHeartbeatS, until = that window's end
 *   (silence beats any overlapping active window).
 * - else an `active` window covering now → `active` with intervalS = window.intervalS ?? activeIntervalS;
 *   until = end of the merged run of overlapping/adjacent active windows (cut short by the next silence start).
 * - else → `idle`, intervalS = idleHeartbeatS, until = start of the next active window (null if none).
 * - windows are half-open [startsAt, endsAt). Unsorted and overlapping windows are allowed.
 * - when several active windows overlap now, the smallest intervalS wins.
 * - `window` is the window that decided the mode (null for plain idle); `next` the window that changes it next.
 */
export function resolveMode(config: DeviceConfig | null, now: number): ModeResolution {
  return notImplemented(config, now);
}
