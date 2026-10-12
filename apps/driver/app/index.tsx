import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { StyleSheet, Text, View } from "react-native";

// Placeholder until pairing + sync land: shows what the phone runs, so staff can check an install.
export default function Home() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>ECI Shuttle</Text>
      <Text style={styles.mode}>Not paired yet</Text>
      <Text style={styles.meta}>
        v{Constants.expoConfig?.version} · {Updates.updateId ?? "built-in"} · {Updates.channel ?? "no channel"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 28, fontWeight: "700", color: "#111" },
  mode: { fontSize: 20, marginTop: 12, color: "#111" },
  meta: { fontSize: 13, color: "#555", marginTop: 24 },
});
