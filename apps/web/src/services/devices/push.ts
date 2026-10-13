/** svc-devices: deliver a queued push (outbox kind "push"), called by the worker queue job. */
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { devices } from "@/db/schema";
import { type DeliveryResult, mutate, type OutboxJob, type PushPayload, systemActor } from "../kernel";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo per-message errors worth another try; everything else (InvalidCredentials, MessageTooBig …) is final. */
const RETRYABLE = new Set(["MessageRateExceeded"]);

type Ticket = { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } };

/**
 * Data-only Expo push ("sync now") to the device's push_token via https://exp.host/--/api/v2/push/send
 * (Authorization: Bearer EXPO_ACCESS_TOKEN when set). DeviceNotRegistered clears push_token. `fetchImpl`
 * injectable; never call Expo from tests.
 *
 * Killed and revoked phones are still pushed: the sync is how they learn it. A retry (job.attempts > 0) is
 * skipped as delivered when the phone has synced since the job was queued, since that sync did the job.
 */
export async function deliverPush(db: Db, job: OutboxJob, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  const { deviceId, reason } = job.payload as PushPayload;
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
  if (!device) return { ok: false, retry: false, error: "device not found" };
  if (!device.pushToken) return { ok: false, retry: false, error: "no push token" };
  if (job.attempts > 0 && device.lastSyncAt && device.lastSyncAt > job.createdAt) return { ok: true };

  const token = process.env.EXPO_ACCESS_TOKEN;
  let res: Response;
  try {
    res = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify([
        // no title/body: a data-only message wakes the app's background task without showing anything
        { to: device.pushToken, data: { type: "sync", deviceId, reason }, priority: "high", _contentAvailable: true },
      ]),
    });
  } catch (e) {
    return { ok: false, retry: true, error: `network: ${(e as Error).message}` };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const retry = res.status === 429 || res.status >= 500;
    return { ok: false, retry, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  let body: { data?: Ticket[]; errors?: unknown[] };
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, retry: true, error: `bad JSON from Expo: ${text.slice(0, 300)}` };
  }
  const ticket = body.data?.[0];
  if (!ticket) return { ok: false, retry: false, error: `Expo: ${JSON.stringify(body.errors ?? body).slice(0, 300)}` };
  if (ticket.status === "ok") {
    // delivery to FCM is only known from the receipt: keep the ticket id findable in the worker log
    console.log(`[push] device ${deviceId} ticket ${ticket.id ?? "?"}`);
    return { ok: true };
  }

  const code = ticket.details?.error ?? "unknown";
  const error = `Expo ${code}: ${ticket.message ?? ""}`.trim();
  if (code === "DeviceNotRegistered") {
    await clearPushToken(db, device, device.pushToken);
    return { ok: false, retry: false, error };
  }
  return { ok: false, retry: RETRYABLE.has(code), error };
}

const STALE = Symbol("token already replaced");

/** Only clears the token that failed: the phone may have reported a fresh one while we were sending. */
async function clearPushToken(db: Db, device: typeof devices.$inferSelect, stale: string) {
  const meta = {
    action: "device.push_token_cleared",
    entity: "device",
    entityId: device.id,
    workspaceId: device.workspaceId,
    reason: "Expo DeviceNotRegistered",
  };
  try {
    await mutate(db, systemActor("queue"), meta, async (tx) => {
      const [after] = await tx
        .update(devices)
        .set({ pushToken: null })
        .where(and(eq(devices.id, device.id), eq(devices.pushToken, stale)))
        .returning();
      if (!after) throw STALE; // nothing changed, so no audit row either
      return { before: { ...after, pushToken: stale }, after, result: undefined };
    });
  } catch (e) {
    if (e !== STALE) throw e;
  }
}
