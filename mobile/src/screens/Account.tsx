import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView } from "react-native";
import { DateTime } from "luxon";
import { api, API_URL } from "../api";
import { Button, Card, ErrorText, H, Input, P } from "../ui";
import type { Nav, Session } from "../../App";

interface Auth { session: Session | null; signIn: (e: string, p: string) => Promise<void>; signOut: () => Promise<void> }

export function AccountScreen({ nav, auth }: { nav: Nav; auth: Auth }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bookings, setBookings] = useState<any[]>([]);

  useEffect(() => { if (auth.session) api<any[]>("/auth/my-bookings").then(setBookings).catch(() => {}); }, [auth.session]);

  if (!auth.session) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <H size={24}>Sign in</H>
        <ErrorText>{error}</ErrorText>
        <Input label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Input label="Password" secureTextEntry value={password} onChangeText={setPassword} />
        <Button primary busy={busy} title="Sign in" onPress={async () => {
          setBusy(true); setError("");
          try { await auth.signIn(email, password); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }} />
        <P muted small>New? Create an account on the website: {API_URL.replace(":4000", ":5173")}/register</P>
      </ScrollView>
    );
  }

  const { user, businesses } = auth.session;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <H size={24}>Hi, {user.name}</H>
      {businesses.length > 0 && (
        <Card>
          <H size={17}>Businesses you manage</H>
          {businesses.map((b) => <Button key={b.id} title={`${b.name} — bookings`} onPress={() => nav.go({ name: "admin", businessId: b.id })} />)}
        </Card>
      )}
      <Card>
        <H size={17}>My bookings</H>
        {bookings.length === 0 && <P muted>No bookings yet.</P>}
        {bookings.map((b) => (
          <Pressable key={b.code} onPress={() => Linking.openURL(`${API_URL.replace(":4000", ":5173")}/manage/${b.manage_token}`)}>
            <P>{b.service_name} · {b.business_name}</P>
            <P muted small>{DateTime.fromISO(b.starts_at).toFormat("ccc d LLL, h:mm a")} · {b.status}</P>
          </Pressable>
        ))}
      </Card>
      <Button danger title="Sign out" onPress={auth.signOut} />
    </ScrollView>
  );
}
