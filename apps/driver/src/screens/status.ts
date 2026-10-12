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

export type StatusInput = {
  config: SyncResponse;
  /** resolveMode(config, now) */
  resolution: ModeResolution;
  lastSyncAt: number | null;
  appVersion: string;
  now: number;
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
};

/** Everything the status screen shows, as text. */
export function statusView({ config, resolution: r, lastSyncAt, appVersion, now }: StatusInput): StatusView {
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
  };
}
