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
  | { ok: false; state: SyncState; error: SyncError; sentPings: 0 };

const DEFAULT_TIMEOUT_MS = 20_000;

async function post(deps: SyncDeps, url: string, token: string, body: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await deps.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** One origin: the parsed response, or why it failed. Never throws. */
async function tryOrigin(
  deps: SyncDeps,
  origin: string,
  token: string,
  body: string,
): Promise<{ response: SyncResponse } | { error: SyncError }> {
  let res: Response;
  try {
    res = await post(deps, `${origin}/api/device/sync`, token, body);
  } catch {
    return { error: "network" as const };
  }
  if (res.status === 401) return { error: "unauthorized" as const };
  if (!res.ok) return { error: `http_${res.status}` as const };
  try {
    const parsed = SyncResponse.safeParse(await res.json());
    return parsed.success ? { response: parsed.data } : { error: "invalid_response" as const };
  } catch {
    return { error: "invalid_response" as const };
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
  const fail = (error: SyncError): SyncOutcome => {
    const s = getState();
    return { ok: false, state: { ...s, failures: s.failures + 1 }, error, sentPings: 0 };
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
