import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export const colors = {
  ink: "#111",
  muted: "#555",
  line: "#ddd",
  bg: "#fff",
  green: "#137333",
  greenBg: "#e6f4ea",
  amber: "#8a5a00",
  amberBg: "#fef3d6",
  red: "#b3261e",
  redBg: "#fce8e6",
  blue: "#0b57d0",
};

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.title} accessibilityRole="header">
          {title}
        </Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Button({
  label,
  onPress,
  kind = "primary",
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        kind === "secondary" && s.btnSecondary,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[s.btnText, kind === "secondary" && { color: colors.blue }]}>{label}</Text>
    </Pressable>
  );
}

export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: "700", color: colors.ink },
  text: { fontSize: 17, lineHeight: 24, color: colors.ink },
  muted: { fontSize: 14, color: colors.muted },
  error: { fontSize: 16, color: colors.red },
  btn: { backgroundColor: colors.blue, borderRadius: 10, paddingVertical: 16, alignItems: "center" },
  btnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.blue },
  btnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
