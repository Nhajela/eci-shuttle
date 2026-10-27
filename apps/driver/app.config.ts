import type { ExpoConfig } from "expo/config";

// Expo project positive-sum-company/edge-city-india-shuttles; not a secret.
// A constant, never env: the fingerprint hashes this config, so build and `eas update` must see the same value.
export const EAS_PROJECT_ID = "77b687ca-c0d9-4ea7-92b4-7d5344c96069";
const easProjectId = EAS_PROJECT_ID;

if (!easProjectId && process.env.EAS_BUILD) {
  throw new Error(
    "EAS_PROJECT_ID is empty in apps/driver/app.config.ts: run `eas init` and commit the id, or this APK can never get OTA updates.",
  );
}

const config: ExpoConfig = {
  name: "ECI Shuttle Driver",
  slug: "edge-city-india-shuttles",
  owner: "positive-sum-company",
  scheme: "ecishuttle",
  version: "0.1.1",
  orientation: "portrait",
  platforms: ["android"],
  userInterfaceStyle: "automatic",
  // Native changes (location service, permissions, SDK) must bump `version`, so old APKs ignore OTA they can't run.
  // Not "fingerprint": with pnpm the fingerprint differs between this machine and EAS and the build refuses.
  runtimeVersion: { policy: "appVersion" },
  updates: {
    // The app never restarts, so the server decides when to fetch and apply (targetUpdateId in sync).
    checkAutomatically: "NEVER",
    ...(easProjectId ? { url: `https://u.expo.dev/${easProjectId}` } : {}),
  },
  android: {
    package: "com.positivesumcompany.ecishuttle.driver",
    // Firebase project eci-shuttles; FCM V1 key is stored in Expo credentials, not here.
    googleServicesFile: "./google-services.json",
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "RECEIVE_BOOT_COMPLETED",
      "WAKE_LOCK",
      "POST_NOTIFICATIONS",
      "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      "CAMERA",
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-updates",
    "expo-dev-client",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Shares the shuttle's location with riders during your service hours only.",
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    ["expo-notifications", {}],
    ["expo-camera", { cameraPermission: "Scan the pairing QR code from admin.", recordAudioAndroid: false }],
  ],
  extra: {
    // Built-in domain, never a host (SPEC §2a). Sync responses may override with apiOrigin.
    apiOrigin: "https://eci-shuttle.positivesumcompany.com",
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  experiments: { typedRoutes: true },
};

export default config;
