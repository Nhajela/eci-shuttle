import { IST_OFFSET_MIN, type ModeResolution, type SyncResponse } from "@eci-shuttle/shared/contracts";

const DAY = 86_400_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
// India has no DST, so shifting by the fixed offset and reading UTC fields gives IST wall time.
const ist = (ms: number) => new Date(ms + IST_OFFSET_MIN * 60_000);
const istDay = (ms: number) => Math.floor((ms + IST_OFFSET_MIN * 60_000) / DAY);

/** "10:05" today, "tomorrow 07:00", otherwise "Fri 16 Oct 23:59". All IST. */
export function formatIst(ms: number, now: number): string {
  const d = ist(ms);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const days = istDay(ms) - istDay(now);
  if (days === 0) return hm;
  if (days === 1) return `tomorrow ${hm}`;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm}`;
}

/** true when `version` is below `min` (dotted numbers; missing parts count as 0). */
export function isOlderVersion(version: string, min: string | null): boolean {
  if (!min) return false;
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** Plain words for the runtime's lastError (SyncError, or "timeout"). Null = no error to show. */
export function syncProblem(error: string | null): string | null {
  if (!error) return null;
  if (error === "unauthorized") return "The server did not accept this phone. Ask the shuttle team.";
  if (error === "network") return "No internet. Trying again soon.";
  if (error === "timeout") return "The server took too long. Trying again soon.";
  if (error === "invalid_response" || error === "invalid_request")
    return "The server sent something this app can't read.";
  const http = /^http_(\d{3})$/.exec(error);
  if (http) {
    const code = Number(http[1]);
    if (code === 429) return "The server is busy. Trying again soon.";
    if (code >= 500) return `The server had a problem (${code}). Trying again soon.`;
    return `The server refused the update (${code}).`;
  }
  return "The last sync failed.";
}

export type StatusInput = {
  config: SyncResponse;
  /** resolveMode(config, now) */
  resolution: ModeResolution;
  lastSyncAt: number | null;
  appVersion: string;
  now: number;
  /** runtime's last sync error, null after a success */
  lastError?: string | null;
  /** tracking should be running but only opening the app can start it */
  needsApp?: boolean;
};

export type StatusView = {
  tone: "active" | "idle" | "stopped";
  headline: string;
  detail: string | null;
  next: string;
  vehicle: string;
  lastSync: string;
  showResume: boolean;
  newApkUrl: string | null;
  /** why the last sync failed, or null */
  problem: string | null;
  /** "Open the app to start tracking" when the app is needed to start the location task, or null */
  notice: string | null;
};

/** Everything the status screen shows, as text. */
export function statusView({
  config,
  resolution: r,
  lastSyncAt,
  appVersion,
  now,
  lastError = null,
  needsApp = false,
}: StatusInput): StatusView {
  const until = r.until === null ? "" : ` until ${formatIst(r.until, now)}`;
  const headline =
    r.mode === "active"
      ? `Sharing location${until}`
      : r.mode === "killed"
        ? "Stopped by the shuttle team"
        : r.mode === "revoked" || r.mode === "unpaired"
          ? "This phone is no longer paired. Ask the shuttle team to pair it again."
          : `Paused${until}`;
  // resolveMode's `next` may be a silence window; the driver wants the next time they'll be sharing.
  const nextWin = config.schedule
    .filter((w) => w.mode === "active" && w.startsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt)[0];
  const next = nextWin
    ? `${formatIst(nextWin.startsAt, now)} – ${formatIst(nextWin.endsAt, now)}${nextWin.label ? ` · ${nextWin.label}` : ""}`
    : r.mode === "active"
      ? "Nothing scheduled after this"
      : "Nothing scheduled in the next 48 hours";
  let lastSync = "Never";
  if (lastSyncAt !== null) {
    const min = Math.floor((now - lastSyncAt) / 60_000);
    const ago = min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
    lastSync = `${ago} (${formatIst(lastSyncAt, now)})`;
  }
  return {
    tone: r.mode === "active" ? "active" : r.mode === "idle" ? "idle" : "stopped",
    headline,
    detail: r.mode === "active" ? (r.window?.label ?? null) : null,
    next,
    vehicle: config.vehicleName ?? "Not assigned",
    lastSync,
    showResume: r.mode === "killed",
    newApkUrl: config.apkUrl && isOlderVersion(appVersion, config.minAppVersion) ? config.apkUrl : null,
    problem: syncProblem(lastError),
    // only while tracking is wanted: a killed or unpaired phone must not be told to start it
    notice: needsApp && (r.mode === "active" || r.mode === "idle") ? "Open the app to start tracking" : null,
  };
}
