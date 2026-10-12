/** POST /api/device/sync (SPEC §4). One attempt, with fallback to the previous origin when the current one is unreachable. */
import { type Ping, SyncResponse } from "@eci-shuttle/shared/contracts";
import { applyResponse, buildSyncRequest, MAX_PINGS_PER_SYNC, type SyncState, type Telemetry } from "./sync";

export type SyncDeps = { fetch: typeof fetch; now: () => number; timeoutMs?: number };

export type SyncError = "unpaired" | "network" | "unauthorized" | "invalid_response" | `http_${number}`;

export type SyncOutcome =
  | {
      ok: true;
      state: SyncState;
      response: SyncResponse;
      /** remove this many pings from the queue head */
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

/**
 * Run one sync. Never throws: a failure returns the state with `failures` + 1 so nextSyncDelayMs backs off.
 * The caller persists `state` and, on ok, drops `sentPings` pings from its queue (the server dedupes retries).
 */
export async function syncOnce(
  state: SyncState,
  telemetry: Telemetry,
  pings: Ping[],
  deps: SyncDeps,
): Promise<SyncOutcome> {
  if (!state.token) return { ok: false, state, error: "unpaired", sentPings: 0 };
  const fail = (error: SyncError): SyncOutcome => ({
    ok: false,
    state: { ...state, failures: state.failures + 1 },
    error,
    sentPings: 0,
  });

  const sentAt = deps.now();
  const req = buildSyncRequest(state, telemetry, pings, sentAt);
  const body = JSON.stringify(req);

  let httpRes: Response | null = null;
  for (const origin of [state.apiOrigin, state.fallbackOrigin]) {
    if (!origin) continue;
    try {
      httpRes = await post(deps, `${origin}/api/device/sync`, state.token, body);
      break;
    } catch {
      // unreachable or timed out: try the fallback origin
    }
  }
  if (!httpRes) return fail("network");
  if (httpRes.status === 401) return fail("unauthorized");
  if (!httpRes.ok) return fail(`http_${httpRes.status}`);

  let parsed: ReturnType<typeof SyncResponse.safeParse>;
  try {
    parsed = SyncResponse.safeParse(await httpRes.json());
  } catch {
    return fail("invalid_response");
  }
  if (!parsed.success) return fail("invalid_response");

  const next = applyResponse(state, parsed.data, {
    sentAt,
    receivedAt: deps.now(),
    resumeSent: req.resume === true,
  });
  return { ok: true, state: next, response: parsed.data, sentPings: Math.min(pings.length, MAX_PINGS_PER_SYNC) };
}
