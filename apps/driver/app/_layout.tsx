import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { runtime } from "../src/runtime/native";

// While the app is open, check every 15s whether a sync is due: covers a pending Resume (killed, so no location
// wakes) and a phone whose location service can't start yet (permissions still being set up).
const TICK_MS = 15_000;

export default function RootLayout() {
  useEffect(() => {
    const t = setInterval(() => void runtime.tick(), TICK_MS);
    const sub = AppState.addEventListener("change", (st) => st === "active" && void runtime.sync());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, []);
  return <Stack screenOptions={{ headerShown: false }} />;
}
