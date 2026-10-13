/**
 * Driver sync, pure part (SPEC §4): the state kept on disk, building a SyncRequest, applying a SyncResponse,
 * clock offset, retry backoff and when to sync next. Every function takes "now"; I/O lives in ./client.
 */
import { type ModeResolution, Ping, type SyncRequest, type SyncResponse } from "@eci-shuttle/shared/contracts";

/** SPEC §4: "every ~15s" while active. */
export const ACTIVE_SYNC_MS = 15_000;
export const BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
/** SyncRequest.pings max. */
export const MAX_PINGS_PER_SYNC = 5_000;
/** how soon a newly killed phone sends its one acknowledging sync */
export const KILL_ACK_DELAY_MS = 1_000;

/** What the sync loop persists between runs. The caller stores it (on disk) after every sync. */
export type SyncState = {
  /** bearer device token; null = unpaired or wiped by a revoke */
  token: string | null;
  /** last config from the server; kill is latched here (see applyResponse) */
  config: SyncResponse | null;
  apiOrigin: string;
  /** the origin before the last apiOrigin change, tried when apiOrigin is unreachable (SPEC §2a) */
  fallbackOrigin: string | null;
  /** serverTime − phone clock; resolveMode runs on serverNow() so windows switch on server time */
  clockOffsetMs: number;
  /** the driver pressed Resume; sent as resume: true until a sync succeeds */
  resumePending: boolean;
  /** killed, but the server has not yet heard this phone report "killed": one more sync acknowledges it */
  killAckPending?: boolean;
  /** phone clock of the last successful sync, for "last successful sync" on the home screen */
  lastSyncAt: number | null;
  /** consecutive failed syncs, drives backoff */
  failures: number;
};

/** What the phone reports about itself on every sync (everything in SyncRequest the sync code can't compute). */
export type Telemetry = Pick<
  SyncRequest,
  "battery" | "charging" | "permissions" | "reportedMode" | "appVersion" | "updateId" | "updateFailed" | "pushToken"
>;

export const initialSyncState = (apiOrigin: string): SyncState => ({
  token: null,
  config: null,
  apiOrigin,
  fallbackOrigin: null,
  clockOffsetMs: 0,
  resumePending: false,
  lastSyncAt: null,
  failures: 0,
});

/** Server time = midpoint of the round trip on the phone clock (NTP-style; good to ± half the RTT). */
export const clockOffsetMs = (sentAt: number, receivedAt: number, serverTime: number) =>
  serverTime - Math.round((sentAt + receivedAt) / 2);

export const serverNow = (state: SyncState, now: number) => now + state.clockOffsetMs;

/** Exponential backoff with jitter: step doubles per failure, result in [50%, 100%] of it. `random` is in [0, 1]. */
export function backoffMs(failures: number, random: number): number {
  if (failures <= 0) return 0;
  const step = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
  return Math.round(step * (0.5 + 0.5 * random));
}

/**
 * Milliseconds until the next sync, or null for none (killed, revoked, unpaired).
 * `resolution` is resolveMode(state.config, serverNow(state, now)); `now` is on the same (server) clock.
 * Idle wakes at the next mode change if that comes before the heartbeat. After failures, retries sooner with backoff.
 */
export function nextSyncDelayMs(
  resolution: ModeResolution,
  now: number,
  state: SyncState,
  random = Math.random(),
): number | null {
  if (!state.token) return null;
  let regular: number | null = null;
  if (resolution.mode === "active" || (resolution.mode === "killed" && state.resumePending)) regular = ACTIVE_SYNC_MS;
  else if (resolution.mode === "killed" && state.killAckPending) regular = KILL_ACK_DELAY_MS;
  else if (resolution.mode === "idle" && resolution.intervalS) {
    regular = resolution.intervalS * 1000;
    if (resolution.until !== null) regular = Math.max(1_000, Math.min(regular, resolution.until - now));
  }
  if (regular === null) return null;
  return state.failures > 0 ? Math.min(regular, backoffMs(state.failures, random)) : regular;
}

const inRange = (v: number | null, min: number, max: number) =>
  v !== null && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** Blank out-of-range optional readings (expo-battery says -1 for unknown); drop pings still invalid, so one can't 400 the batch forever. */
export function cleanPings(pings: Ping[]): Ping[] {
  return pings.flatMap((p) => {
    const r = Ping.safeParse({
      ...p,
      battery: inRange(p.battery, 0, 100),
      speed: inRange(p.speed, 0, Number.MAX_VALUE),
      heading: inRange(p.heading, 0, 360),
    });
    return r.success ? [r.data] : [];
  });
}

/** Sends the first MAX_PINGS_PER_SYNC pings minus invalid ones; on success the caller drops every ping it scanned. */
export function buildSyncRequest(state: SyncState, telemetry: Telemetry, pings: Ping[], now: number): SyncRequest {
  return {
    ...telemetry,
    battery: inRange(telemetry.battery, 0, 100),
    pings: cleanPings(pings.slice(0, MAX_PINGS_PER_SYNC)),
    appliedConfigVersion: state.config?.configVersion ?? 0,
    clock: now,
    ...(state.resumePending && { resume: true as const }),
  };
}

/**
 * Fold a successful response into the state.
 * - Kill is latched: once killed, only a response to a request that carried resume: true can clear it (SPEC §4).
 * - Revoke wipes the token; the config stays so resolveMode says `revoked` until the phone is paired again.
 * - A new apiOrigin is used from now on, the previous one kept as fallback.
 */
export function applyResponse(
  state: SyncState,
  res: SyncResponse,
  t: { sentAt: number; receivedAt: number; resumeSent: boolean; reportedKilled?: boolean },
): SyncState {
  const killed = res.killed || (!!state.config?.killed && !t.resumeSent);
  const moved = res.apiOrigin !== state.apiOrigin;
  return {
    token: res.revoked ? null : state.token,
    config: { ...res, killed },
    apiOrigin: res.apiOrigin,
    fallbackOrigin: moved ? state.apiOrigin : state.fallbackOrigin,
    clockOffsetMs: clockOffsetMs(t.sentAt, t.receivedAt, res.serverTime),
    // a resume that went out is done either way; if still killed the driver can press again
    resumePending: state.resumePending && !t.resumeSent,
    // a newly killed phone reports "killed" once, so admin sees the kill confirmed (not "still active")
    killAckPending: killed && !t.reportedKilled,
    lastSyncAt: t.receivedAt,
    failures: 0,
  };
}

/** The Resume button. Only meaningful while killed; the next sync carries it. */
export const requestResume = (state: SyncState): SyncState =>
  state.config?.killed ? { ...state, resumePending: true } : state;
