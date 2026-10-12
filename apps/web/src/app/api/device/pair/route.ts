/** web-device: POST /api/device/pair (SPEC §4): devices/pairing.pairDevice. */
import { PairRequest } from "@eci-shuttle/shared";
import { db } from "@/db";
import { pairDevice } from "@/services/devices/pairing";
import { errorResponse, rateLimiter, readBody, tooMany } from "../rateLimit";

export const dynamic = "force-dynamic";

// No device yet, so limit per client address (10/min), plus a global cap (60/min) so a guesser spread
// over many addresses still gets only ~1,800 tries in a code's 30-minute life.
const limit = rateLimiter(10, 60_000);
const all = rateLimiter(60, 60_000);

// Cloudflare sets cf-connecting-ip and overwrites any client value. Without it, the last XFF hop is the one
// our own proxy added; the first is whatever the client sent.
const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip")?.trim() ||
  req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
  "unknown";

export async function POST(req: Request) {
  try {
    const now = new Date();
    // Per-address check first, so one blocked guesser doesn't also burn the shared budget.
    const wait = limit(clientIp(req), now.getTime()) ?? all("*", now.getTime());
    if (wait !== null) return tooMany(wait);
    const input = await readBody(req, PairRequest);
    return Response.json(await pairDevice(db(), input, now), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
