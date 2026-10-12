import type { ModeResolution, SyncResponse } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SYNC_MS,
  applyResponse,
  backoffMs,
  buildSyncRequest,
  clockOffsetMs,
  initialSyncState,
  MAX_BACKOFF_MS,
  MAX_PINGS_PER_SYNC,
  nextSyncDelayMs,
  requestResume,
  type SyncState,
  serverNow,
} from "./sync";

const T = 1_760_000_000_000;

const response = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 3,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: "https://eci-shuttle.positivesumcompany.com",
  serverTime: T,
  vehicleName: "Bus 1",
  workspace: { slug: "live", isLive: true },
  ...over,
});

const paired = (over: Partial<SyncState> = {}): SyncState => ({
  ...initialSyncState("https://eci-shuttle.positivesumcompany.com"),
  token: "tok",
  config: response(),
  ...over,
});

const res = (over: Partial<ModeResolution>): ModeResolution => ({
  mode: "idle",
  intervalS: 900,
  until: null,
  window: null,
  next: null,
  ...over,
});

describe("clock offset", () => {
  it("assumes the server stamped serverTime halfway through the round trip", () => {
    expect(clockOffsetMs(T, T + 400, T + 5_000)).toBe(4_800);
    expect(clockOffsetMs(T, T + 400, T - 1_000)).toBe(-1_200);
  });

  it("serverNow shifts the phone clock by the stored offset", () => {
    expect(serverNow(paired({ clockOffsetMs: 4_800 }), T)).toBe(T + 4_800);
  });
});

describe("backoff", () => {
  it("is zero with no failures", () => {
    expect(backoffMs(0, 0.5)).toBe(0);
  });

  it("doubles per failure with jitter in [50%, 100%] of the step", () => {
    expect(backoffMs(1, 1)).toBe(5_000);
    expect(backoffMs(1, 0)).toBe(2_500);
    expect(backoffMs(3, 1)).toBe(20_000);
  });

  it("caps at MAX_BACKOFF_MS however many failures", () => {
    expect(backoffMs(50, 1)).toBe(MAX_BACKOFF_MS);
  });
});

describe("heartbeat scheduling by mode (SPEC §4)", () => {
  it("syncs every ~15s while active", () => {
    expect(nextSyncDelayMs(res({ mode: "active", intervalS: 10, until: T + 3_600_000 }), T, paired())).toBe(
      ACTIVE_SYNC_MS,
    );
  });

  it("syncs every idleHeartbeatS while idle", () => {
    expect(nextSyncDelayMs(res({ mode: "idle", intervalS: 900 }), T, paired())).toBe(900_000);
  });

  it("wakes at the next mode change if that comes before the heartbeat", () => {
    expect(nextSyncDelayMs(res({ mode: "idle", intervalS: 900, until: T + 60_000 }), T, paired())).toBe(60_000);
  });

  it("never schedules a zero or negative wait for a change that already passed", () => {
    expect(nextSyncDelayMs(res({ mode: "idle", intervalS: 900, until: T - 5 }), T, paired())).toBe(1_000);
  });

  it("does not sync when killed, revoked or unpaired", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(nextSyncDelayMs(res({ mode, intervalS: null }), T, paired())).toBeNull();
    }
  });

  it("keeps syncing when killed with a pending resume, until the server takes it", () => {
    expect(nextSyncDelayMs(res({ mode: "killed", intervalS: null }), T, paired({ resumePending: true }))).toBe(
      ACTIVE_SYNC_MS,
    );
  });

  it("does not sync without a token, even with a pending resume", () => {
    expect(nextSyncDelayMs(res({ mode: "killed" }), T, paired({ token: null, resumePending: true }))).toBeNull();
  });

  it("retries a failed sync with backoff, never later than the regular cadence", () => {
    expect(nextSyncDelayMs(res({ mode: "idle", intervalS: 900 }), T, paired({ failures: 2 }), 1)).toBe(10_000);
    expect(nextSyncDelayMs(res({ mode: "active", intervalS: 10 }), T, paired({ failures: 6 }), 1)).toBe(ACTIVE_SYNC_MS);
  });
});

describe("buildSyncRequest", () => {
  const telemetry = {
    battery: 80,
    charging: false,
    permissions: { location: "always", preciseLocation: true, notifications: true, batteryOptimizationExempt: true },
    reportedMode: "active",
    appVersion: "1.0.0",
    updateId: null,
  } as const;

  it("reports the applied config version and the phone clock", () => {
    const req = buildSyncRequest(paired(), telemetry, [], T);
    expect(req.appliedConfigVersion).toBe(3);
    expect(req.clock).toBe(T);
    expect(req.resume).toBeUndefined();
  });

  it("reports config version 0 before any config", () => {
    expect(buildSyncRequest(paired({ config: null }), telemetry, [], T).appliedConfigVersion).toBe(0);
  });

  it("sends resume: true while a resume is pending", () => {
    expect(buildSyncRequest(paired({ resumePending: true }), telemetry, [], T).resume).toBe(true);
  });

  it(`sends at most ${MAX_PINGS_PER_SYNC} pings, oldest first`, () => {
    const ping = { recordedAt: T, lat: 15.6, lng: 73.7, accuracy: 5, speed: null, heading: null, battery: null };
    const pings = Array.from({ length: MAX_PINGS_PER_SYNC + 7 }, (_, i) => ({ ...ping, recordedAt: T + i }));
    const req = buildSyncRequest(paired(), telemetry, pings, T);
    expect(req.pings).toHaveLength(MAX_PINGS_PER_SYNC);
    expect(req.pings[0]?.recordedAt).toBe(T);
  });
});

describe("applyResponse", () => {
  const timing = { sentAt: T, receivedAt: T + 200, resumeSent: false };

  it("stores the config, clock offset and last sync time, and clears failures", () => {
    const s = applyResponse(paired({ failures: 4 }), response({ configVersion: 9, serverTime: T + 1_100 }), timing);
    expect(s.config?.configVersion).toBe(9);
    expect(s.clockOffsetMs).toBe(1_000);
    expect(s.lastSyncAt).toBe(T + 200);
    expect(s.failures).toBe(0);
  });

  it("moves to a new apiOrigin and keeps the previous one as fallback", () => {
    const s = applyResponse(paired(), response({ apiOrigin: "https://new.example.com" }), timing);
    expect(s.apiOrigin).toBe("https://new.example.com");
    expect(s.fallbackOrigin).toBe("https://eci-shuttle.positivesumcompany.com");
  });

  it("keeps the fallback when the origin is unchanged", () => {
    const s = applyResponse(paired({ fallbackOrigin: "https://old.example.com" }), response(), timing);
    expect(s.fallbackOrigin).toBe("https://old.example.com");
  });

  it("latches a kill: a later response without killed does not clear it", () => {
    const killed = applyResponse(paired(), response({ killed: true }), timing);
    expect(killed.config?.killed).toBe(true);
    expect(applyResponse(killed, response({ killed: false }), timing).config?.killed).toBe(true);
  });

  it("clears the kill and the resume flag once a resume was sent and the server agrees", () => {
    const s = applyResponse(
      paired({ config: response({ killed: true }), resumePending: true }),
      response({ killed: false }),
      { ...timing, resumeSent: true },
    );
    expect(s.config?.killed).toBe(false);
    expect(s.resumePending).toBe(false);
  });

  it("keeps a resume pressed while the request was in flight", () => {
    const s = applyResponse(
      paired({ config: response({ killed: true }), resumePending: true }),
      response({ killed: true }),
      timing,
    );
    expect(s.resumePending).toBe(true);
  });

  it("wipes the token on revoke but keeps the config so the phone shows revoked", () => {
    const s = applyResponse(paired(), response({ revoked: true }), timing);
    expect(s.token).toBeNull();
    expect(s.config?.revoked).toBe(true);
  });
});

describe("requestResume", () => {
  it("sets the flag only when the phone is killed", () => {
    expect(requestResume(paired({ config: response({ killed: true }) })).resumePending).toBe(true);
    expect(requestResume(paired()).resumePending).toBe(false);
  });
});
