/** web-device: POST /api/device/pair (SPEC §4): devices/pairing.pairDevice. */
import { PairRequest } from "@eci-shuttle/shared";
import { db } from "@/db";
import { pairDevice } from "@/services/devices/pairing";
import { errorResponse, rateLimiter, readBody, tooMany } from "../rateLimit";

export const dynamic = "force-dynamic";

// No device yet, so limit per client address: 10 tries a minute makes guessing a 6-digit code hopeless.
const limit = rateLimiter(10, 60_000);

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const now = new Date();
    const wait = limit(ip, now.getTime());
    if (wait !== null) return tooMany(wait);
    const input = await readBody(req, PairRequest);
    return Response.json(await pairDevice(db(), input, now), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
