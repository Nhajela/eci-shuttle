// ponytail: the pieces of task/driver-sync src/sync/sync.ts the screens use, copied with the same signatures.
// On merge, delete this file and import from "../sync/sync".
import type { Ping, SyncRequest, SyncResponse } from "@eci-shuttle/shared/contracts";

export const MAX_PINGS_PER_SYNC = 5_000;

export type SyncState = {
  token: string | null;
  config: SyncResponse | null;
  apiOrigin: string;
  fallbackOrigin: string | null;
  /** serverTime − phone clock; resolveMode runs on serverNow() so windows switch on server time */
  clockOffsetMs: number;
  resumePending: boolean;
  /** phone clock of the last successful sync */
  lastSyncAt: number | null;
  failures: number;
};

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

export const serverNow = (state: SyncState, now: number) => now + state.clockOffsetMs;

export function buildSyncRequest(state: SyncState, telemetry: Telemetry, pings: Ping[], now: number): SyncRequest {
  return {
    ...telemetry,
    pings: pings.slice(0, MAX_PINGS_PER_SYNC),
    appliedConfigVersion: state.config?.configVersion ?? 0,
    clock: now,
    ...(state.resumePending && { resume: true as const }),
  };
}
