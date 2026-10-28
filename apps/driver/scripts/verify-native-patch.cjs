#!/usr/bin/env node
/**
 * EAS build guard (eas-build-post-install): fail the build if the expo-location patch
 * (patches/expo-location@57.0.21.patch, registered in pnpm-workspace.yaml) was not applied.
 * An APK at version ≥ 0.1.1 without it ships the old background-start bug while the app believes it is patched.
 * pnpm < 10 ignores patchedDependencies in pnpm-workspace.yaml, which is how a 0.1.1 APK shipped unpatched.
 */
const fs = require("node:fs");
const path = require("node:path");

const MARKERS = ["Could not enter the foreground", "background location permission is not granted"];
const pkg = require.resolve("expo-location/package.json", { paths: [path.join(__dirname, "..")] });
const file = path.join(
  path.dirname(pkg),
  "android/src/main/java/expo/modules/location/taskConsumers/LocationTaskConsumer.kt",
);
const src = fs.readFileSync(file, "utf8");
const missing = MARKERS.filter((m) => !src.includes(m));
if (missing.length) {
  console.error(`expo-location patch NOT applied (${file}); missing: ${missing.join(", ")}`);
  console.error("Use pnpm >= 10 for the EAS build (eas.json build.<profile>.pnpm) so patchedDependencies apply.");
  process.exit(1);
}
console.log("expo-location patch applied ✓");
