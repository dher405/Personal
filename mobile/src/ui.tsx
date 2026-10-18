import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from "react-native";

const light = { bg: "#f6f7f9", surface: "#ffffff", text: "#16181d", muted: "#5d6470", border: "#e2e5ea", accent: "#2f6fed", accentText: "#ffffff", bad: "#c0352b" };
const dark = { bg: "#0f1115", surface: "#171a21", text: "#e8eaee", muted: "#9aa2ae", border: "#2a2f39", accent: "#6a9bff", accentText: "#0b0d12", bad: "#ff7b70" };
export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === "dark" ? dark : light);

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.surface, borderColor: t.border }]}>{children}</View>;
}

export function H({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return <Text style={{ fontSize: size, fontWeight: "700", color: useTheme().text, marginBottom: 6 }}>{children}</Text>;
}

export function P({ children, muted, small }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  const t = useTheme();
  return <Text style={{ color: muted ? t.muted : t.text, fontSize: small ? 13 : 15 }}>{children}</Text>;
}

export function Button({ title, onPress, primary, danger, disabled, busy }: { title: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.button, { borderColor: primary ? t.accent : t.border, backgroundColor: primary ? t.accent : t.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={primary ? t.accentText : t.text} /> : (
        <Text style={{ color: primary ? t.accentText : danger ? t.bad : t.text, fontWeight: "600" }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ color: t.muted, fontSize: 13, marginBottom: 4 }}>{props.label}</Text>
      <TextInput placeholderTextColor={t.muted} {...props} style={[s.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]} />
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <Text style={{ color: useTheme().bad, marginVertical: 6 }}>{children}</Text> : null;
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 12 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", marginVertical: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
