/** web-device: fixed-window rate limit + error mapping shared by the two device routes. */

import type { z } from "zod";
import { httpStatus, parseInput, userMessage } from "@/services/kernel";

// ponytail: in-process memory, so each server instance counts on its own. Fine for one container; move to
// Postgres/Redis if the web app ever runs as several replicas.
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { start: number; count: number }>();
  /** Counts one call; null when allowed, else whole seconds until the window reopens. */
  return (key: string, now: number): number | null => {
    if (hits.size > 10_000) for (const [k, h] of hits) if (now - h.start >= windowMs) hits.delete(k);
    const h = hits.get(key);
    if (!h || now - h.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return null;
    }
    if (h.count < limit) {
      h.count++;
      return null;
    }
    return Math.ceil((h.start + windowMs - now) / 1000);
  };
}

export const tooMany = (retryAfterS: number) =>
  Response.json(
    { error: "Too many requests. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfterS) } },
  );

/** Request JSON validated against a protocol schema; bad JSON or a bad shape throws INVALID. */
export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  return parseInput(schema, await req.json().catch(() => undefined));
}

export function errorResponse(e: unknown): Response {
  const status = httpStatus(e);
  if (status === 500) console.error(e);
  return Response.json({ error: userMessage(e) }, { status, headers: { "Cache-Control": "no-store" } });
}
