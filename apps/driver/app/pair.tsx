import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";
import { pair } from "../src/screens/device";
import { parsePairingInput } from "../src/screens/pairing";
import { Button, colors, Screen, s } from "../src/screens/ui";

export default function Pair() {
  const [camera, requestCamera] = useCameraPermissions();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the scanner fires many times per second; only act on the first read
  const scanning = useRef(false);

  async function submit(raw: string) {
    const input = parsePairingInput(raw);
    if (!input) {
      setError("That isn't a pairing code. Scan the QR from the shuttle team, or type its 6 digits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pair(input.code, input.origin, Date.now());
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      scanning.current = false;
    }
  }

  return (
    <Screen title="Pair this phone">
      <Text style={s.text}>Scan the QR code the shuttle team shows you.</Text>
      {camera?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={
            busy
              ? undefined
              : ({ data }) => {
                  if (scanning.current) return;
                  scanning.current = true;
                  void submit(data);
                }
          }
        />
      ) : (
        <Button label="Open camera" onPress={() => void requestCamera()} />
      )}
      <Text style={s.text}>Or type the 6-digit code:</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          keyboardType="number-pad"
          maxLength={7}
          placeholder="123456"
          accessibilityLabel="6-digit pairing code"
          onSubmitEditing={() => void submit(typed)}
        />
      </View>
      <Button label="Pair" disabled={busy} onPress={() => void submit(typed)} />
      {busy && <ActivityIndicator size="large" color={colors.blue} />}
      {error && (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { width: "100%", aspectRatio: 1, borderRadius: 12, overflow: "hidden" },
  row: { flexDirection: "row" },
  input: {
    flex: 1,
    fontSize: 28,
    letterSpacing: 6,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: 12,
    color: colors.ink,
    textAlign: "center",
  },
});
