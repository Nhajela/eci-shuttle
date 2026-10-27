import type { ModeResolution, SyncResponse, Window } from "@eci-shuttle/shared/contracts";
import { describe, expect, it } from "vitest";
import { formatIst, isOlderVersion, statusView, syncProblem } from "./status";

const MIN = 60_000;
/** epoch ms of an IST wall-clock time on 2026-10-14 (+ dayOffset days) */
const at = (h: number, m = 0, dayOffset = 0) => Date.UTC(2026, 9, 14 + dayOffset, h, m) - 330 * MIN;
const NOW = at(9);

const win = (startsAt: number, endsAt: number, over: Partial<Window> = {}): Window => ({
  startsAt,
  endsAt,
  mode: "active",
  intervalS: null,
  source: "service",
  label: "Riva ↔ Circle",
  ...over,
});

const config = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  configVersion: 3,
  killed: false,
  revoked: false,
  schedule: [],
  activeIntervalS: 10,
  idleHeartbeatS: 900,
  minAppVersion: null,
  apkUrl: null,
  targetUpdateId: null,
  apiOrigin: "https://eci-shuttle.example.com",
  serverTime: NOW,
  vehicleName: "Van 2",
  workspace: { slug: "live", isLive: true },
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

describe("formatIst", () => {
  it("shows IST clock time, with a day word when not today", () => {
    expect(formatIst(at(10, 5), NOW)).toBe("10:05");
    expect(formatIst(at(7, 0, 1), NOW)).toBe("tomorrow 07:00");
    expect(formatIst(at(23, 59, 2), NOW)).toBe("Fri 16 Oct 23:59");
    expect(formatIst(at(0, 10), at(0, 5))).toBe("00:10");
    expect(formatIst(at(23, 50, -1), at(0, 5))).toBe("Tue 13 Oct 23:50");
  });
});

describe("isOlderVersion", () => {
  it("compares dotted numbers", () => {
    expect(isOlderVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isOlderVersion("1.10.0", "1.9.9")).toBe(false);
    expect(isOlderVersion("1.2", "1.2.0")).toBe(false);
    expect(isOlderVersion("1.2.0", "1.2.1")).toBe(true);
    expect(isOlderVersion("1.2.0", null)).toBe(false);
  });
});

describe("statusView", () => {
  const base = { appVersion: "0.1.0", lastSyncAt: NOW - 3 * MIN, now: NOW };

  it("active: sharing until the window ends, with the vehicle and last sync", () => {
    const w = win(at(8, 45), at(11));
    const v = statusView({
      ...base,
      config: config({ schedule: [w] }),
      resolution: res({ mode: "active", until: at(11), window: w }),
    });
    expect(v).toEqual({
      tone: "active",
      headline: "Sharing location until 11:00",
      detail: "Riva ↔ Circle",
      next: "Nothing scheduled after this",
      vehicle: "Van 2",
      lastSync: "3 min ago (08:57)",
      showResume: false,
      newApkUrl: null,
      problem: null,
      notice: null,
      note: null,
    });
  });

  it("idle: paused, shows the next window in IST", () => {
    const n = win(at(16), at(18), { label: null });
    const v = statusView({ ...base, config: config({ schedule: [n] }), resolution: res({ until: at(16), next: n }) });
    expect(v.tone).toBe("idle");
    expect(v.headline).toBe("Paused until 16:00");
    expect(v.next).toBe("16:00 – 18:00");
  });

  it("silence window: paused until it ends", () => {
    const s = win(at(8), at(12), { mode: "idle", source: "silence", label: null });
    const v = statusView({ ...base, config: config({ schedule: [s] }), resolution: res({ until: at(12), window: s }) });
    expect(v.headline).toBe("Paused until 12:00");
  });

  it("idle with nothing scheduled", () => {
    const v = statusView({ ...base, config: config(), resolution: res({}) });
    expect(v.headline).toBe("Paused");
    expect(v.next).toBe("Nothing scheduled in the next 48 hours");
  });

  it("killed shows Resume; revoked asks to pair again", () => {
    const k = statusView({
      ...base,
      config: config({ killed: true }),
      resolution: res({ mode: "killed", intervalS: null }),
    });
    expect(k).toMatchObject({ tone: "stopped", showResume: true });
    const r = statusView({
      ...base,
      config: config({ revoked: true }),
      resolution: res({ mode: "revoked", intervalS: null }),
    });
    expect(r.showResume).toBe(false);
    expect(r.headline).toMatch(/pair/i);
  });

  it("no vehicle, never synced", () => {
    const v = statusView({ ...base, lastSyncAt: null, config: config({ vehicleName: null }), resolution: res({}) });
    expect(v.vehicle).toBe("Not assigned");
    expect(v.lastSync).toBe("Never");
  });

  it("offers the APK only when this app is below minAppVersion", () => {
    const c = config({ minAppVersion: "0.2.0", apkUrl: "https://x.example.com/driver.apk" });
    expect(statusView({ ...base, config: c, resolution: res({}) }).newApkUrl).toBe("https://x.example.com/driver.apk");
    expect(statusView({ ...base, appVersion: "0.2.0", config: c, resolution: res({}) }).newApkUrl).toBeNull();
  });

  it("last sync reads in minutes, hours or 'just now'", () => {
    const v = (lastSyncAt: number) =>
      statusView({ ...base, lastSyncAt, config: config(), resolution: res({}) }).lastSync;
    expect(v(NOW - 125 * MIN)).toBe("2 h ago (06:55)");
    expect(v(NOW - 10_000)).toBe("just now (08:59)");
  });
});

describe("syncProblem: plain words for the last sync error", () => {
  it.each([
    ["unauthorized", "The server did not accept this phone. Ask the shuttle team."],
    ["network", "No internet. Trying again soon."],
    ["timeout", "The server took too long. Trying again soon."],
    ["http_429", "The server is busy. Trying again soon."],
    ["http_503", "The server had a problem (503). Trying again soon."],
    ["http_400", "The server refused the update (400)."],
    ["invalid_response", "The server sent something this app can't read."],
    ["invalid_request", "The server sent something this app can't read."],
    ["whatever", "The last sync failed."],
  ])("%s", (code, text) => {
    expect(syncProblem(code)).toBe(text);
  });
  it("nothing when there is no error", () => {
    expect(syncProblem(null)).toBeNull();
  });
});

describe("statusView: problem and notice", () => {
  const base = { appVersion: "0.1.0", lastSyncAt: NOW - 3 * MIN, now: NOW, config: config() };

  it("shows the last sync error", () => {
    const v = statusView({ ...base, resolution: res({}), lastError: "network" });
    expect(v.problem).toBe("No internet. Trying again soon.");
    expect(statusView({ ...base, resolution: res({}), lastError: null }).problem).toBeNull();
  });

  it("asks to open the app when tracking should run but can't start from the background", () => {
    const active = res({ mode: "active", intervalS: 10, window: win(at(8), at(11)), until: at(11) });
    expect(statusView({ ...base, resolution: active, needsApp: true }).notice).toBe("Open the app to start tracking");
    expect(statusView({ ...base, resolution: res({ until: at(16) }), needsApp: true }).notice).toBe(
      "Open the app to start tracking",
    );
    expect(statusView({ ...base, resolution: active, needsApp: false }).notice).toBeNull();
  });

  it("no notice when the phone is stopped or unpaired, whatever an old flag says", () => {
    for (const mode of ["killed", "revoked", "unpaired"] as const) {
      expect(statusView({ ...base, resolution: res({ mode, intervalS: null }), needsApp: true }).notice).toBeNull();
    }
  });
});

describe("statusView: patch fallback note", () => {
  const base = { appVersion: "0.1.1", lastSyncAt: NOW - 3 * MIN, now: NOW, config: config() };
  it("tells the driver to open the app each day when background updates were refused", () => {
    const v = statusView({ ...base, resolution: res({ until: at(16) }), degraded: true });
    expect(v.note).toBe("Background tracking can't restart itself on this phone. Open the app before each run.");
    expect(statusView({ ...base, resolution: res({}), degraded: false }).note).toBeNull();
    expect(
      statusView({ ...base, resolution: res({ mode: "killed", intervalS: null }), degraded: true }).note,
    ).toBeNull();
  });
});
