/**
 * auth-next: Next gives server components no request path, so admin requests carry it as `x-pathname` (path +
 * query). lib/session.requireAdmin reads it to send logged-out people back to the exact page after /login.
 * Always overwritten here, and requireAdmin still runs it through safeNext.
 */
import { type NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
