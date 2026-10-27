import * as Updates from "expo-updates";

/**
 * Version of the installed APK (not of the OTA bundle), or null when unknown (dev client, Expo Go).
 * app.config.ts uses runtimeVersion { policy: "appVersion" }, so the runtime version baked into the APK is its app
 * version. expo-constants has no native-version field in this SDK and expo-application is not a dependency of the
 * app, so this is the one source that needs no new package. Unknown counts as unpatched (the safe side).
 */
export const nativeVersion = (): string | null => Updates.runtimeVersion ?? null;
