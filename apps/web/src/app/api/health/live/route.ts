/** GET /api/health/live: the liveness check for Coolify (which can't put "?live=1" in its health check path). */
import { GET as health } from "../route";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  url.searchParams.set("live", "1");
  return health(new Request(url, req));
}
