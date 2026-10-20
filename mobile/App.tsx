import { useEffect, useState } from "react";
import { Platform, SafeAreaView, StatusBar as RNStatusBar, View, Pressable, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { api, loadDeviceToken, loadToken, saveDeviceToken, saveToken } from "./src/api";
import { useTheme } from "./src/ui";
import { DiscoverScreen } from "./src/screens/Discover";
import { BusinessScreen } from "./src/screens/Business";
import { ChatScreen } from "./src/screens/Chat";
import { AccountScreen } from "./src/screens/Account";
import { AdminScreen } from "./src/screens/Admin";

export type Route =
  | { name: "discover" }
  | { name: "business"; slug: string }
  | { name: "chat"; slug: string; businessName: string }
  | { name: "account" }
  | { name: "admin"; businessId: string };

export interface Session { user: { id: string; name: string; email: string; role: string }; businesses: { id: string; name: string; slug: string }[] }
export interface Nav { go: (r: Route) => void; back: () => void }

export interface TwoFactor { id: string; email: string; codeSent: boolean; methods: string[]; rememberDays: number }

const deviceFields = async () => ({ deviceToken: (await loadDeviceToken()) ?? undefined, deviceName: `Slotwise app (${Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : Platform.OS})` });

export default function App() {
  const t = useTheme();
  const [stack, setStack] = useState<Route[]>([{ name: "discover" }]);
  const [session, setSession] = useState<Session | null>(null);
  const route = stack[stack.length - 1];
  const nav: Nav = { go: (r) => setStack([...stack, r]), back: () => setStack(stack.length > 1 ? stack.slice(0, -1) : stack) };

  useEffect(() => {
    loadToken().then((tok) => {
      if (tok) api<Session>("/auth/me").then(setSession).catch(() => saveToken(null));
    });
  }, []);

  const finishSignIn = async (s: Session & { token: string; deviceToken?: string }) => {
    await saveToken(s.token);
    if (s.deviceToken) await saveDeviceToken(s.deviceToken);
    setSession(s);
  };

  const auth = {
    session,
    /** Returns the second step when one is needed (an emailed code); otherwise signs in. */
    signIn: async (email: string, password: string) => {
      const res = await api<any>("/auth/login", { body: { email, password, ...(await deviceFields()) } });
      if (res.twoFactor) return res.twoFactor as TwoFactor;
      await finishSignIn(res);
      return null;
    },
    verifyCode: async (challengeId: string, code: string, remember: boolean) => {
      await finishSignIn(await api<any>("/auth/2fa/verify", { body: { challengeId, code, remember, ...(await deviceFields()) } }));
    },
    resendCode: (challengeId: string) => api("/auth/2fa/send-code", { body: { challengeId } }),
    signOut: async () => { await saveToken(null); setSession(null); setStack([{ name: "discover" }]); },
  };

  const tab = (name: "discover" | "account", label: string) => (
    <Pressable onPress={() => setStack([{ name }])} style={{ flex: 1, padding: 14, alignItems: "center" }}>
      <Text style={{ color: stack[0].name === name ? t.accent : t.muted, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, paddingTop: RNStatusBar.currentHeight }}>
      <StatusBar style="auto" />
      <View style={{ flex: 1 }}>
        {route.name === "discover" && <DiscoverScreen nav={nav} />}
        {route.name === "business" && <BusinessScreen nav={nav} slug={route.slug} session={session} />}
        {route.name === "chat" && <ChatScreen nav={nav} slug={route.slug} businessName={route.businessName} />}
        {route.name === "account" && <AccountScreen nav={nav} auth={auth} />}
        {route.name === "admin" && <AdminScreen nav={nav} businessId={route.businessId} />}
      </View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
        {tab("discover", "Book")}
        {tab("account", session ? "Account" : "Sign in")}
      </View>
    </SafeAreaView>
  );
}
