import { resolveMode } from "@eci-shuttle/shared/schedule";
import { Redirect, router } from "expo-router";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { appVersion, refresh, resume, useDevice } from "../src/screens/device";
import { statusView } from "../src/screens/status";
import { serverNow } from "../src/screens/syncStub";
import { Button, colors, Screen, s } from "../src/screens/ui";

const TONE = {
  active: { bg: colors.greenBg, fg: colors.green },
  idle: { bg: colors.amberBg, fg: colors.amber },
  stopped: { bg: colors.redBg, fg: colors.red },
};

export default function Status() {
  const d = useDevice();
  const [now, setNow] = useState(Date.now());
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    // the background sync writes to disk; re-read it so mode and last sync stay current
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!d) return null;
  if (!d.config || !d.deviceConfig) return <Redirect href="/" />;
  // same inputs as the background service: latched kill and server clock
  const serverTime = serverNow(d.sync, now);
  const v = statusView({
    config: d.config,
    resolution: resolveMode(d.deviceConfig, serverTime),
    lastSyncAt: d.sync.lastSyncAt === null ? null : serverNow(d.sync, d.sync.lastSyncAt),
    appVersion: appVersion(),
    now: serverTime,
  });
  const tone = TONE[v.tone];

  return (
    <Screen title="ECI Shuttle">
      <View style={[styles.card, { backgroundColor: tone.bg }]}>
        <Text style={[styles.headline, { color: tone.fg }]} accessibilityLiveRegion="polite">
          {v.headline}
        </Text>
        {v.detail && <Text style={s.text}>{v.detail}</Text>}
      </View>

      {v.showResume && (
        <Button
          label={resuming ? "Resuming…" : "Resume"}
          disabled={resuming}
          onPress={() => {
            setResuming(true);
            void resume().finally(() => setResuming(false));
          }}
        />
      )}
      {d.config.revoked && (
        <Button label="Pair again" onPress={() => router.push("/pair")} />
      )}

      <Row label="Next" value={v.next} />
      <Row label="Vehicle" value={v.vehicle} />
      <Row label="Last sync" value={v.lastSync} />

      {v.newApkUrl && (
        <Button label="New version: tap to install" onPress={() => void Linking.openURL(v.newApkUrl as string)} />
      )}
      <Button kind="secondary" label="Check phone setup" onPress={() => router.push("/permissions")} />

      <Text style={s.muted}>
        v{appVersion()} · {Updates.updateId ?? "built-in"} · {d.config.workspace.slug}
      </Text>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.text}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, padding: 20, gap: 8 },
  headline: { fontSize: 24, fontWeight: "700" },
  row: { gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line },
});
