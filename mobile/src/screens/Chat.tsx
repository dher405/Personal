import { useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { Button, useTheme } from "../ui";
import type { Nav } from "../../App";

interface Msg { role: "user" | "assistant"; text: string; link?: string }

/** Customer AI booking chat (same endpoint as the web widget). */
export function ChatScreen({ nav, slug, businessName }: { nav: Nav; slug: string; businessName: string }) {
  const t = useTheme();
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", text: `Hi! I'm ${businessName}'s booking assistant. What would you like to book?` }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);
  const list = useRef<FlatList<Msg>>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await api("/public/businesses/" + slug + "/chat", { body: { message: text, sessionId: sessionId.current } });
      sessionId.current = res.sessionId;
      const created = res.events.find((e: any) => e.type === "booking_created");
      setMessages((m) => [...m, { role: "assistant", text: res.reply, link: created?.paymentUrl ?? created?.booking?.manageUrl }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: `Sorry — ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable onPress={nav.back} style={{ padding: 16, paddingBottom: 4 }}><Text style={{ color: t.accent }}>‹ Back</Text></Pressable>
      <FlatList
        ref={list}
        data={busy ? [...messages, { role: "assistant", text: "…" } as Msg] : messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        onContentSizeChange={() => list.current?.scrollToEnd()}
        renderItem={({ item }) => (
          <View style={{
            alignSelf: item.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", padding: 10, borderRadius: 12,
            backgroundColor: item.role === "user" ? t.accent : t.surface, borderWidth: item.role === "user" ? 0 : 1, borderColor: t.border,
          }}>
            <Text style={{ color: item.role === "user" ? t.accentText : t.text }}>{item.text}</Text>
            {item.link && <Button primary title="Open booking / pay" onPress={() => Linking.openURL(item.link!)} />}
          </View>
        )}
      />
      <View style={{ flexDirection: "row", padding: 12, gap: 8, borderTopWidth: 1, borderColor: t.border }}>
        <TextInput
          style={{ flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, color: t.text, backgroundColor: t.surface }}
          placeholder="Type a message…" placeholderTextColor={t.muted} value={input} onChangeText={setInput} onSubmitEditing={send} returnKeyType="send"
        />
        <Button primary title="Send" onPress={send} disabled={!input.trim()} busy={busy} />
      </View>
    </KeyboardAvoidingView>
  );
}
