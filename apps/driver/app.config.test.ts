import { describe, expect, it } from "vitest";
import config from "./app.config";

describe("app.config", () => {
  it("is Android-only with a fixed package name", () => {
    expect(config.platforms).toEqual(["android"]);
    expect(config.android?.package).toBe("com.positivesumcompany.ecishuttle.driver");
  });

  it("leaves OTA to the server: no automatic check, fingerprint runtime version", () => {
    expect(config.updates?.checkAutomatically).toBe("NEVER");
    expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
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
