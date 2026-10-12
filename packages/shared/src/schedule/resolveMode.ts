import type { DeviceConfig, ModeResolution, Window } from "../contracts";

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
 *
 * Implementation: `until` is the first window boundary after now where the state changes (active ↔ idle; or,
 * while silenced, the silence ending). An active start hidden under a silence is not a change.
 * `next` is the window deciding the state at `until` (null when that is plain idle).
 */
export function resolveMode(config: DeviceConfig | null, now: number): ModeResolution {
  const off = (mode: ModeResolution["mode"]): ModeResolution => ({
    mode,
    intervalS: null,
    until: null,
    window: null,
    next: null,
  });
  if (!config) return off("unpaired");
  // killed/revoked are latched by the caller (disk / DB); here they simply beat any schedule
  if (config.revoked) return off("revoked");
  if (config.killed) return off("killed");

  const ws = config.schedule;
  const defaultIv = config.activeIntervalS;
  const cur = decide(ws, now);
  const silenced = cur?.mode === "idle";
  const boundaries = [...new Set(ws.flatMap((w) => [w.startsAt, w.endsAt]))]
    .filter((t) => t > now)
    .sort((a, b) => a - b);
  let until: number | null = null;
  let next: Window | null = null;
  for (const t of boundaries) {
    const at = decide(ws, t);
    const changed = silenced ? at?.mode !== "idle" : (at?.mode === "active") !== (cur?.mode === "active");
    if (changed) {
      until = t;
      next = at;
      break;
    }
  }
  const active = cur?.mode === "active";
  return {
    mode: active ? "active" : "idle",
    intervalS: active ? (cur.intervalS ?? config.activeIntervalS) : config.idleHeartbeatS,
    until,
    window: cur,
    next,
  };

  function decide(list: Window[], t: number): Window | null {
    const covering = list.filter((w) => w.startsAt <= t && t < w.endsAt);
    const silence = covering
      .filter((w) => w.mode === "idle")
      .sort((a, b) => b.endsAt - a.endsAt || a.startsAt - b.startsAt)[0];
    if (silence) return silence;
    const iv = (w: Window) => w.intervalS ?? defaultIv;
    return covering.sort((a, b) => iv(a) - iv(b) || a.startsAt - b.startsAt || b.endsAt - a.endsAt)[0] ?? null;
  }
}

const IST_OFFSET_MS = 330 * 60_000; // Asia/Kolkata has no DST
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** IST "HH:MM", prefixed with the weekday when `at` falls on a different IST date than `now`. */
function istTime(at: number, now: number): string {
  const d = new Date(at + IST_OFFSET_MS);
  const hhmm = d.toISOString().slice(11, 16);
  const sameDay = d.toISOString().slice(0, 10) === new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
  return sameDay ? hhmm : `${WEEKDAYS[d.getUTCDay()]} ${hhmm}`;
}

/** The phone's foreground-service notification line (SPEC §4), e.g. "Sharing location until 11:00". */
export function notificationText(r: ModeResolution, now: number): string {
  const until = r.until === null ? "" : ` until ${istTime(r.until, now)}`;
  switch (r.mode) {
    case "active":
      return `Sharing location${until}${r.window?.label ? ` · ${r.window.label}` : ""}`;
    case "idle":
      return `Paused${until}`;
    case "killed":
      return "Stopped by the organisers. Tap Resume to share again.";
    case "revoked":
      return "This phone was removed. Pair it again to share.";
    case "unpaired":
      return "Not paired";
  }
}
