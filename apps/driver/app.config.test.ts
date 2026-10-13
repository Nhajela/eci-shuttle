import { afterEach, describe, expect, it, vi } from "vitest";
import config, { EAS_PROJECT_ID } from "./app.config";

describe("app.config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not read the EAS project id from env, so build and `eas update` hash the same fingerprint", async () => {
    vi.stubEnv("EAS_PROJECT_ID", "from-a-laptop-shell");
    vi.resetModules();
    const fresh = (await import("./app.config")).default;
    expect(fresh).toEqual(config);
  });

  it("sets the OTA url and extra.eas.projectId from the committed id, or neither", () => {
    if (EAS_PROJECT_ID) {
      expect(config.updates?.url).toBe(`https://u.expo.dev/${EAS_PROJECT_ID}`);
      expect(config.extra?.eas).toEqual({ projectId: EAS_PROJECT_ID });
    } else {
      expect(config.updates?.url).toBeUndefined();
      expect(config.extra?.eas).toBeUndefined();
    }
  });

  it.skipIf(EAS_PROJECT_ID)("refuses to build on EAS without a project id, so no APK ships without OTA", async () => {
    vi.stubEnv("EAS_BUILD", "true");
    vi.resetModules();
    await expect(import("./app.config")).rejects.toThrow(/EAS_PROJECT_ID/);
  });

  it("is Android-only with a fixed package name", () => {
    expect(config.platforms).toEqual(["android"]);
    expect(config.android?.package).toBe("com.positivesumcompany.ecishuttle.driver");
  });

  it("leaves OTA to the server: no automatic check, appVersion runtime version (fingerprint differs local vs EAS under pnpm)", () => {
    expect(config.updates?.checkAutomatically).toBe("NEVER");
    expect(config.runtimeVersion).toEqual({ policy: "appVersion" });
  });

  it("asks for background location and a location foreground service", () => {
    const perms = config.android?.permissions ?? [];
    for (const p of [
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "RECEIVE_BOOT_COMPLETED",
      "POST_NOTIFICATIONS",
      "CAMERA",
    ]) {
      expect(perms).toContain(p);
    }
    const location = config.plugins?.find((p) => Array.isArray(p) && p[0] === "expo-location");
    expect(location?.[1]).toMatchObject({
      isAndroidBackgroundLocationEnabled: true,
      isAndroidForegroundServiceEnabled: true,
    });
  });
});
