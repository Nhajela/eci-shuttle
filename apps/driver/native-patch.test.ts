/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "./app.config";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

// The expo-location Kotlin patch (in-place background update, FGS restore on boot) is part of the native build.
// If expo-location is upgraded the patch must be regenerated (`pnpm patch expo-location@<new>`) and re-verified
// on a phone; this test makes that impossible to forget.
describe("expo-location native patch", () => {
  const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  const entry = /^\s+(expo-location@[\d.]+):\s*(\S+)\s*$/m.exec(workspace);

  it("is registered in pnpm-workspace.yaml and the patch file exists", () => {
    expect(entry).not.toBeNull();
    expect(existsSync(resolve(root, entry?.[2] ?? "missing"))).toBe(true);
  });

  it("targets the expo-location version the driver app resolves", () => {
    const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
    const installed = /expo-location@([\d.]+)\(patch_hash=/.exec(lock)?.[1];
    expect(installed).toBeDefined();
    expect(entry?.[1]).toBe(`expo-location@${installed}`);
    expect(pkg.dependencies["expo-location"]).toMatch(/^~?57\./);
  });

  it("keeps the three behaviours the driver relies on", () => {
    const patch = readFileSync(resolve(root, entry?.[2] ?? "missing"), "utf8");
    // module accepts a background re-registration only for an already running service
    expect(patch).toContain("updatesRunningService");
    // consumer no longer bails out when backgrounded, and a refused start is caught instead of fatal
    expect(patch).toContain("could not be started");
    // the service reports whether it is really foreground
    expect(patch).toContain("var isForeground");
  });

  it("changes the native runtime, so the app version moved past 0.1.0 (old APKs keep getting 0.1.0 OTA only)", () => {
    expect(config.version).toBe("0.1.1");
    expect(config.runtimeVersion).toEqual({ policy: "appVersion" });
  });
});
