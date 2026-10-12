import { Ping } from "@eci-shuttle/shared/contracts";
import { type KV, parseJson, serial } from "./kv";

const KEY = "ping-queue";
/** Pings older than this are dropped unsent (SPEC: queue capped at 24h). */
export const MAX_AGE_MS = 24 * 3_600_000;
/** Default upload batch; the sync contract allows up to 5000. */
export const BATCH_SIZE = 500;

function readQueue(raw: string | null): Ping[] {
  const v = parseJson(raw);
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    const r = Ping.safeParse(p);
    return r.success ? [r.data] : [];
  });
}

/** Oldest first, deduped on recordedAt (as the server does), nothing older than 24h. */
function tidy(pings: Ping[], now: number): Ping[] {
  const byTime = new Map<number, Ping>();
  for (const p of pings) if (p.recordedAt >= now - MAX_AGE_MS) byTime.set(p.recordedAt, p);
  return [...byTime.values()].sort((a, b) => a.recordedAt - b.recordedAt);
}

// ponytail: rewrites the whole JSON file on each push (~1.3MB at 24h of 10s pings); switch to an append log if that shows up in battery.
export function createPingQueue(kv: KV) {
  const one = serial();
  const load = async () => readQueue(await kv.get(KEY));
  const save = (q: Ping[]) => kv.set(KEY, JSON.stringify(q));

  return {
    push: (pings: Ping[], now: number) => one(async () => save(tidy([...(await load()), ...pings], now))),
    /** The next batch to upload. Pings stay queued until ack(). */
    batch: (now: number, max = BATCH_SIZE) => one(async () => tidy(await load(), now).slice(0, max)),
    /** The server accepted this batch. */
    ack: (sent: Ping[]) =>
      one(async () => {
        const done = new Set(sent.map((p) => p.recordedAt));
        await save((await load()).filter((p) => !done.has(p.recordedAt)));
      }),
    /** Drop everything: the pings belong to a token that is gone (revoked or replaced). */
    clear: () => one(() => kv.del(KEY)),
    size: () => one(async () => (await load()).length),
  };
}

export type PingQueue = ReturnType<typeof createPingQueue>;
