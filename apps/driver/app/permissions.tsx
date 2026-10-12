import type { Permissions } from "@eci-shuttle/shared/contracts";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { finishSetup, useDevice } from "../src/screens/device";
import { fix, readPermissions } from "../src/screens/permissions";
import { checklist } from "../src/screens/setup";
import { Button, colors, Screen, s } from "../src/screens/ui";

export default function PermissionChecklist() {
  const setupDoneAt = useDevice()?.setupDoneAt ?? null;
  const [perms, setPerms] = useState<Permissions | null>(null);

  useEffect(() => {
    const refresh = () => void readPermissions().then(setPerms);
    refresh();
    // the fixes happen in system screens; re-check when the driver comes back
    const sub = AppState.addEventListener("change", (st) => st === "active" && refresh());
    return () => sub.remove();
  }, []);

  if (!perms) return <Screen title="Phone setup">{null}</Screen>;
  const { items, allSet } = checklist(perms);

  return (
    <Screen title="Phone setup">
      {items.map((item) => (
        <View key={item.key} style={styles.item}>
          <Text style={styles.mark} accessibilityLabel={item.done ? "Done" : item.done === null ? "Check" : "To do"}>
            {item.done ? "✓" : item.done === null ? "?" : "!"}
          </Text>
          <View style={styles.itemBody}>
            <Text style={[s.text, { fontWeight: "600" }]}>
              {item.title}
              {item.required ? "" : " (if your phone has it)"}
            </Text>
            <Text style={s.muted}>{item.hint}</Text>
            {!item.done && <Button kind="secondary" label="Open settings" onPress={() => void fix(item.key)} />}
          </View>
        </View>
      ))}
      {allSet ? (
        <View style={styles.allSet}>
          <Text style={styles.allSetText}>All set</Text>
          <Text style={s.text}>You can close the app. It runs by itself.</Text>
          <Button
            label="Done"
            onPress={async () => {
              if (setupDoneAt === null) await finishSetup(Date.now());
              router.replace("/status");
            }}
          />
        </View>
      ) : (
        <Text style={s.muted}>Fix the items marked “!” so the shuttle shows up for riders.</Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: "row", gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  itemBody: { flex: 1, gap: 6 },
  mark: { fontSize: 22, width: 28, textAlign: "center", fontWeight: "700", color: colors.ink },
  allSet: { backgroundColor: colors.greenBg, borderRadius: 12, padding: 20, gap: 12 },
  allSetText: { fontSize: 28, fontWeight: "700", color: colors.green },
});
