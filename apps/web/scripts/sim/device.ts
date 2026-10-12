/** The simulated phone: an HTTP client of the real device protocol (SPEC §4). No DB, no shortcuts. */
import {
  istHHMM,
  type PairRequest,
  PairResponse,
  type Ping,
  type SyncRequest,
  SyncResponse,
} from "@eci-shuttle/shared";
import { type Plan, positionAt } from "./plan";

export type SimDeps = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export type SimEnd = "stopped" | "killed" | "revoked" | "live";

/** like the real app: sync about every 15 s while active */
const SYNC_EVERY_MS = 15_000;
const APP_VERSION = "sim";

async function post(deps: SimDeps, url: string, body: unknown, token?: string): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const errorText = async (r: Response) => {
  const body = (await r.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `HTTP ${r.status}`;
};

/** POST /api/device/pair: the admin-made code becomes this sim's device token. */
export async function pairSim(origin: string, code: string, deps: SimDeps): Promise<PairResponse> {
  const req: PairRequest = { code, model: "sim", appVersion: APP_VERSION, updateId: null, pushToken: null };
  const r = await post(deps, `${origin}/api/device/pair`, req);
  if (!r.ok) throw new Error(`Pairing failed: ${await errorText(r)}`);
  return PairResponse.parse(await r.json());
}

/**
 * Replays `plan` through POST /api/device/sync until stopped, killed, revoked or moved to the live workspace.
 * GPS every activeIntervalS of real time; at `speed` N the vehicle covers N seconds of the plan per real second,
 * so timestamps stay real (the server never sees future pings). Failed syncs keep their pings queued.
 */
export async function runSim(o: {
  origin: string;
  token: string;
  config: SyncResponse;
  plan: Plan;
  speed: number;
  deps: SimDeps;
  signal?: AbortSignal;
}): Promise<SimEnd> {
  const { deps } = o;
  const start = deps.now();
  let config = o.config;
  let queue: Ping[] = [];
  let lastSync = Number.NEGATIVE_INFINITY;
  for (;;) {
    if (o.signal?.aborted) return "stopped";
    const now = deps.now();
    const p = positionAt(o.plan, ((now - start) / 1000) * o.speed);
    queue.push({
      recordedAt: now,
      lat: p.lat,
      lng: p.lng,
      accuracy: 8,
      speed: p.speedMps * o.speed,
      heading: p.heading,
      battery: 80,
    });
    if (now - lastSync >= SYNC_EVERY_MS) {
      lastSync = now;
      const req: SyncRequest = {
        pings: queue,
        battery: 80,
        charging: true,
        permissions: {
          location: "always",
          preciseLocation: true,
          notifications: true,
          batteryOptimizationExempt: true,
        },
        reportedMode: "active",
        appliedConfigVersion: config.configVersion,
        appVersion: APP_VERSION,
        updateId: null,
        clock: now,
      };
      try {
        const r = await post(deps, `${o.origin}/api/device/sync`, req, o.token);
        if (r.status === 401 || r.status === 403) {
          deps.log(`Token refused (${await errorText(r)}): this sim was revoked. Pair a new one in admin.`);
          return "revoked";
        }
        if (!r.ok) throw new Error(await errorText(r));
        config = SyncResponse.parse(await r.json());
        deps.log(
          `${istHHMM(now)} IST sent ${queue.length} ping(s) at ${p.lat.toFixed(5)},${p.lng.toFixed(5)}` +
            ` · config v${config.configVersion} · ${config.vehicleName ?? "no vehicle assigned"}`,
        );
        queue = [];
        if (config.revoked) return end(deps, "revoked", "Revoked in admin. Stopping.");
        if (config.killed) return end(deps, "killed", "Killed in admin. Stopping.");
        if (config.workspace.isLive) return end(deps, "live", "This phone is now in the live workspace. Stopping.");
      } catch (e) {
        deps.log(`${istHHMM(now)} IST sync failed (${(e as Error).message}); keeping ${queue.length} ping(s).`);
      }
    }
    await deps.sleep(config.activeIntervalS * 1000);
  }
}

function end(deps: SimDeps, why: SimEnd, line: string): SimEnd {
  deps.log(line);
  return why;
}
