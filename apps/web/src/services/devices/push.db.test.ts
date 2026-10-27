import { randomUUID } from "node:crypto";
import { makeWorkspace } from "@tests/factories/core";
import { testDb } from "@tests/helpers/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditLog, devices } from "@/db/schema";
import { enqueue, type OutboxJob } from "../kernel";
import { deliverPush, EXPO_PUSH_URL, REQUEST_TIMEOUT_MS } from "./push";

const db = () => testDb();

async function setup(over: Partial<typeof devices.$inferInsert> = {}) {
  const ws = await makeWorkspace(db());
  const [device] = await db()
    .insert(devices)
    .values({
      workspaceId: ws.id,
      label: "Van 1",
      tokenHash: randomUUID(),
      pushToken: "ExponentPushToken[abc]",
      ...over,
    })
    .returning();
  const job = (await enqueue(db(), {
    workspaceId: ws.id,
    kind: "push",
    payload: { deviceId: device.id, reason: "config" },
  })) as OutboxJob;
  return { ws, device, job };
}

const reply = (body: unknown, status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
const okTicket = () => reply({ data: [{ status: "ok", id: "ticket-1" }] });

afterEach(() => vi.unstubAllEnvs());

describe("deliverPush", () => {
  it("sends one data-only, high-priority sync message to the device's push token", async () => {
    const { device, job } = await setup();
    const f = okTicket();
    expect(await deliverPush(db(), job, f)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    expect(init?.method).toBe("POST");
    const [msg] = JSON.parse(String(init?.body));
    expect(msg).toEqual({
      to: "ExponentPushToken[abc]",
      data: { type: "sync", deviceId: device.id, reason: "config" },
      priority: "high",
      _contentAvailable: true,
    });
    expect(msg.title).toBeUndefined();
    expect(msg.body).toBeUndefined();
  });

  it("the Expo call has a 10 s abort signal; a timeout is a normal retryable failure", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    const { job } = await setup();
    const spy = vi.spyOn(AbortSignal, "timeout");
    const f = okTicket();
    await deliverPush(db(), job, f);
    expect(spy).toHaveBeenCalledWith(10_000);
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    spy.mockImplementation(() => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")));
    const hung = vi.fn(
      (_u: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_res, reject) => {
          if (init?.signal?.aborted) return reject(init.signal.reason);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    expect(await deliverPush(db(), job, hung)).toMatchObject({
      ok: false,
      retry: true,
      error: expect.stringContaining("timed out"),
    });
    spy.mockRestore();
  });

  it("sends the Expo access token as a bearer only when set", async () => {
    const { job } = await setup();
    const f = okTicket();
    vi.stubEnv("EXPO_ACCESS_TOKEN", "");
    await deliverPush(db(), job, f);
    expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
    vi.stubEnv("EXPO_ACCESS_TOKEN", "secret");
    await deliverPush(db(), job, f);
    expect(new Headers(f.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("gives up without calling Expo when the device has no push token or is gone", async () => {
    const { job } = await setup({ pushToken: null });
    const f = okTicket();
    expect(await deliverPush(db(), job, f)).toMatchObject({ ok: false, retry: false });
    const gone = { ...job, payload: { deviceId: randomUUID(), reason: "config" } };
    expect(await deliverPush(db(), gone, f)).toMatchObject({ ok: false, retry: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("still pushes killed and revoked phones, so they sync and learn it", async () => {
    const { job } = await setup({ killedAt: new Date(), revokedAt: new Date() });
    const f = okTicket();
    expect(await deliverPush(db(), job, f)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("DeviceNotRegistered clears push_token (audited) and gives up", async () => {
    const { device, job } = await setup();
    const f = reply({
      data: [{ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }],
    });
    expect(await deliverPush(db(), job, f)).toMatchObject({
      ok: false,
      retry: false,
      error: expect.stringContaining("DeviceNotRegistered"),
    });
    const [after] = await db().select().from(devices).where(eq(devices.id, device.id));
    expect(after.pushToken).toBeNull();
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, "device"), eq(auditLog.entityId, device.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "device.push_token_cleared",
      actorKind: "system",
      before: { pushToken: "ExponentPushToken[abc]" },
      after: { pushToken: null },
    });
  });

  it("does not clear a newer token the phone reported meanwhile", async () => {
    const { device, job } = await setup();
    const f = vi.fn(async () => {
      await db().update(devices).set({ pushToken: "ExponentPushToken[new]" }).where(eq(devices.id, device.id));
      return new Response(JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }));
    });
    await deliverPush(db(), job, f);
    const [after] = await db().select().from(devices).where(eq(devices.id, device.id));
    expect(after.pushToken).toBe("ExponentPushToken[new]");
  });

  it.each([
    ["HTTP 429", () => reply({ errors: [{ code: "TOO_MANY_REQUESTS" }] }, 429)],
    ["HTTP 503", () => reply({}, 503)],
    ["network error", () => vi.fn(async () => Promise.reject(new TypeError("fetch failed")))],
    ["MessageRateExceeded", () => reply({ data: [{ status: "error", details: { error: "MessageRateExceeded" } }] })],
  ])("%s → retry later", async (_name, make) => {
    const { job } = await setup();
    expect(await deliverPush(db(), job, make())).toMatchObject({ ok: false, retry: true });
  });

  it.each([
    ["HTTP 400", () => reply({ errors: [{ code: "VALIDATION_ERROR" }] }, 400)],
    ["InvalidCredentials", () => reply({ data: [{ status: "error", details: { error: "InvalidCredentials" } }] })],
    ["request-level error on 200", () => reply({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] })],
  ])("%s → give up", async (_name, make) => {
    const { job } = await setup();
    expect(await deliverPush(db(), job, make())).toMatchObject({ ok: false, retry: false });
  });

  it("a retry is skipped when the phone has synced since the push was queued", async () => {
    const { device, job } = await setup();
    await db()
      .update(devices)
      .set({ lastSyncAt: new Date(job.createdAt.getTime() + 1000) })
      .where(eq(devices.id, device.id));
    const f = okTicket();
    expect(await deliverPush(db(), { ...job, attempts: 1 }, f)).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
    // a first attempt always sends: "update now" must reach the phone even if it synced a moment ago
    expect(await deliverPush(db(), job, f)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
