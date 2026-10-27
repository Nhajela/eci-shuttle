/**
 * POST /api/device/sync (SPEC §4). One attempt, trying apiOrigin, then the previous origin, then the built-in domain,
 * so a bad apiOrigin from a sync response can't strand the phone (SPEC §2a).
 */
import { type Ping, SyncRequest, SyncResponse } from "@eci-shuttle/shared/contracts";
import { applyResponse, buildSyncRequest, MAX_PINGS_PER_SYNC, type SyncState, type Telemetry } from "./sync";

export type SyncDeps = {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  /** the domain the APK ships with (app.config extra.apiOrigin), tried last */
  builtInOrigin?: string;
};

export type SyncError =
  | "unpaired"
  | "network"
  | "unauthorized"
  | "invalid_response"
  | "invalid_request"
  /** the whole cycle ran out of time (set by the runtime, not by a request) */
  | "timeout"
  /** the token changed (re-pair) while the request was in flight; the response belongs to the old pairing */
  | "superseded"
  | `http_${number}`;

export type SyncOutcome =
  | {
      ok: true;
      state: SyncState;
      response: SyncResponse;
      /** remove this many pings from the queue head (sent or dropped as invalid) */
      sentPings: number;
    }
  | {
      ok: false;
      state: SyncState;
      error: SyncError;
      sentPings: 0;
      /** the server's Retry-After on a 429 (ms, capped); the caller should not sync again before then */
      retryAfterMs?: number;
    };

const DEFAULT_TIMEOUT_MS = 20_000;
/** A server asking for more than this is not believed: the phone must keep checking in. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

type OriginResult = { response: SyncResponse } | { error: SyncError; retryAfterMs?: number };

/** Retry-After is delta-seconds or an HTTP date. Anything else is ignored. */
function parseRetryAfter(h: string | null, now: number): number | undefined {
  if (!h) return undefined;
  const t = h.trim();
  const ms = /^\d+$/.test(t) ? Number(t) * 1000 : Date.parse(t) - now;
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : undefined;
}

/**
 * One origin: the parsed response, or why it failed. Never throws. One deadline covers the request AND the body
 * read: a server that sends headers and then stalls must not hang the sync (and everything queued behind it).
 * The race makes the deadline hold even when the fetch implementation ignores the abort signal.
 */
async function tryOrigin(deps: SyncDeps, origin: string, token: string, body: string): Promise<OriginResult> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error("timeout"));
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  deadline.catch(() => {}); // rejected after we returned: nobody is waiting on it
  try {
    const res = await Promise.race([
      deps.fetch(`${origin}/api/device/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      }),
      deadline,
    ]);
    if (res.status === 401) return { error: "unauthorized" };
    if (res.status === 429)
      return { error: "http_429", retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), deps.now()) };
    if (!res.ok) return { error: `http_${res.status}` };
    let json: unknown;
    try {
      json = await Promise.race([res.json(), deadline]);
    } catch (e) {
      return { error: e instanceof Error && e.message === "timeout" ? "network" : "invalid_response" };
    }
    const parsed = SyncResponse.safeParse(json);
    return parsed.success ? { response: parsed.data } : { error: "invalid_response" };
  } catch {
    return { error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one sync. Never throws. `getState` is read before the request and again after it, so a Resume press or
 * re-pair that happens mid-flight is not overwritten. A failure returns the current state with `failures` + 1
 * so nextSyncDelayMs backs off; a 401 never wipes the token (a misrouted origin must not unpair the phone).
 * The caller persists `state` and, on ok, drops `sentPings` pings from its queue (the server dedupes retries).
 */
export async function syncOnce(
  getState: () => SyncState,
  telemetry: Telemetry,
  pings: Ping[],
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const before = getState();
  const token = before.token;
  const fail = (error: SyncError, retryAfterMs?: number): SyncOutcome => {
    const s = getState();
    return { ok: false, state: { ...s, failures: s.failures + 1 }, error, sentPings: 0, retryAfterMs };
  };
  if (!token) return { ok: false, state: before, error: "unpaired", sentPings: 0 };

  const sentAt = deps.now();
  const req = buildSyncRequest(before, telemetry, pings, sentAt);
  if (!SyncRequest.safeParse(req).success) return fail("invalid_request");
  const body = JSON.stringify(req);

  const origins = [before.apiOrigin, before.fallbackOrigin, deps.builtInOrigin].filter(
    (o, i, all): o is string => !!o && all.indexOf(o) === i,
  );
  let firstError: SyncError = "network";
  let response: SyncResponse | null = null;
  for (const [i, origin] of origins.entries()) {
    const r = await tryOrigin(deps, origin, token, body);
    if ("response" in r) {
      response = r.response;
      break;
    }
    // rate limited: the other origins are the same server, so asking again only makes it worse
    if (r.error === "http_429") return fail(r.error, r.retryAfterMs);
    if (i === 0) firstError = r.error;
  }
  if (!response) return fail(firstError);

  const current = getState();
  if (current.token !== token) return { ok: false, state: current, error: "superseded", sentPings: 0 };
  const next = applyResponse(current, response, {
    sentAt,
    receivedAt: deps.now(),
    resumeSent: req.resume === true,
    reportedKilled: req.reportedMode === "killed",
  });
  return { ok: true, state: next, response, sentPings: Math.min(pings.length, MAX_PINGS_PER_SYNC) };
}
