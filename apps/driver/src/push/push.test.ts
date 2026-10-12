import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  extra: {} as Record<string, unknown>,
  getExpoPushTokenAsync: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ granted: false })),
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: m.extra };
    },
  },
}));
vi.mock("expo-task-manager", () => ({ defineTask: vi.fn() }));
vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(),
  getExpoPushTokenAsync: m.getExpoPushTokenAsync,
  getPermissionsAsync: m.getPermissionsAsync,
}));

const load = async () => (await import("./push")).getPushToken;

describe("getPushToken", () => {
  beforeEach(() => {
    vi.resetModules();
    m.getExpoPushTokenAsync.mockReset();
    m.extra = { eas: { projectId: "p1" } };
  });

  it("returns the token even when notifications were declined (data-only push needs no permission)", async () => {
    m.getExpoPushTokenAsync.mockResolvedValue({ data: "ExponentPushToken[x]" });
    expect(await (await load())()).toBe("ExponentPushToken[x]");
    expect(m.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("omits the field (undefined, not null) without a project id, so the server keeps its token", async () => {
    m.extra = {};
    expect(await (await load())()).toBeUndefined();
    expect(m.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("omits the field on a temporary failure, then retries on the next call", async () => {
    const get = await load();
    m.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("FCM not ready"));
    expect(await get()).toBeUndefined();
    m.getExpoPushTokenAsync.mockResolvedValueOnce({ data: "t2" });
    expect(await get()).toBe("t2");
  });
});
