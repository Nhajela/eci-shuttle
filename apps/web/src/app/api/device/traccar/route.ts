/**
 * Traccar Client (iOS/Android) compatibility: GET/POST /api/device/traccar.
 * The app's "Device identifier" is the device token from pairing, so the phone is a normal device to every service.
 * Accepts the OsmAnd query format (?id=&lat=&lon=&timestamp=&speed=(knots)&bearing=&accuracy=&batt=)
 * and the JSON body newer Traccar Client versions send ({ device_id, location: { coords, battery, timestamp } }).
 * Server-side control (kill, silence, windows) can't reach this app; ingest still drops position outside service.
 */
import type { Ping, SyncRequest } from "@eci-shuttle/shared";
import { db } from "@/db";
import { authenticateDevice, syncDevice } from "@/services/devices/sync";
import { errorResponse, rateLimiter } from "../rateLimit";

export const dynamic = "force-dynamic";

const limit = rateLimiter(30, 60_000);
const KNOTS_TO_MS = 0.514444;

type Fix = { id: string | null; ping: Ping | null; battery: number | null; charging: boolean | null };

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const time = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = num(v);
  if (n !== null) return n < 1e12 ? n * 1000 : n; // seconds or ms
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const clamp = (v: number | null, lo: number, hi: number) => (v === null || v < lo || v > hi ? null : v);

function fromQuery(q: URLSearchParams | Record<string, unknown>): Fix {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : (q[k] as string | undefined)) ?? null;
  const lat = num(get("lat"));
  const lng = num(get("lon") ?? get("lng"));
  const at = time(get("timestamp")) ?? Date.now();
  const speedKn = num(get("speed"));
  const batt = num(get("batt"));
  const ping =
    lat !== null && lng !== null
      ? {
          recordedAt: at,
          lat,
          lng,
          accuracy: num(get("accuracy")) ?? 50,
          speed: speedKn === null ? null : Math.max(0, speedKn * KNOTS_TO_MS),
          heading: clamp(num(get("bearing") ?? get("heading")), 0, 360),
          battery: clamp(batt, 0, 100),
        }
      : null;
  const charge = get("charge");
  return {
    id: get("id") ?? get("deviceid"),
    ping,
    battery: clamp(batt, 0, 100),
    charging: charge == null ? null : charge === "true",
  };
}

function fromJson(b: Record<string, unknown>): Fix {
  const loc = (b.location ?? {}) as Record<string, unknown>;
  const c = (loc.coords ?? {}) as Record<string, unknown>;
  const bat = (loc.battery ?? {}) as Record<string, unknown>;
  const level = num(bat.level);
  const battery = level === null ? null : clamp(Math.round(level <= 1 ? level * 100 : level), 0, 100);
  const lat = num(c.latitude);
  const lng = num(c.longitude);
  const speed = num(c.speed);
  const ping =
    lat !== null && lng !== null
      ? {
          recordedAt: time(loc.timestamp) ?? Date.now(),
          lat,
          lng,
          accuracy: Math.max(0, num(c.accuracy) ?? 50),
          speed: speed === null || speed < 0 ? null : speed,
          heading: clamp(num(c.heading), 0, 360),
          battery,
        }
      : null;
  const charging = typeof bat.is_charging === "boolean" ? bat.is_charging : null;
  return { id: (b.device_id as string | undefined) ?? null, ping, battery, charging };
}

async function handle(req: Request) {
  try {
    const url = new URL(req.url);
    let fix = fromQuery(url.searchParams);
    if (req.method === "POST" && !fix.ping) {
      const type = req.headers.get("content-type") ?? "";
      const text = await req.text();
      if (type.includes("json") || text.trim().startsWith("{")) fix = fromJson(JSON.parse(text));
      else fix = fromQuery(new URLSearchParams(text));
      if (!fix.id) fix.id = url.searchParams.get("id");
    }
    const actor = await authenticateDevice(db(), fix.id);
    const now = new Date();
    const wait = limit(actor.id, now.getTime());
    if (wait !== null) return new Response(null, { status: 429 });
    const input: SyncRequest = {
      pings: fix.ping ? [fix.ping] : [],
      battery: fix.battery,
      charging: fix.charging,
      permissions: { location: "always", preciseLocation: true, notifications: false, batteryOptimizationExempt: true },
      reportedMode: "active",
      appliedConfigVersion: 0,
      appVersion: "traccar",
      updateId: null,
      clock: now.getTime(),
    };
    await syncDevice(db(), actor, input, now);
    return new Response(null, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = handle;
export const POST = handle;
