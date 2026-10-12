/** svc-devices: deliver a queued push (outbox kind "push"), called by the worker queue job. */
import { notImplemented } from "@eci-shuttle/shared";
import type { Db } from "@/db";
import type { DeliveryResult, OutboxJob } from "../kernel";

/**
 * Data-only Expo push ("sync now") to the device's push_token via https://exp.host/--/api/v2/push/send
 * (Authorization: Bearer EXPO_ACCESS_TOKEN when set). DeviceNotRegistered clears push_token. `fetchImpl`
 * injectable; never call Expo from tests.
 */
export async function deliverPush(db: Db, job: OutboxJob, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  return notImplemented(db, job, fetchImpl);
}
