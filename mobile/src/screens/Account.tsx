import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, Switch, View } from "react-native";
import { DateTime } from "luxon";
import { api, API_URL } from "../api";
import { Button, Card, ErrorText, H, Input, P } from "../ui";
import type { Nav, Session, TwoFactor } from "../../App";

interface Auth {
  session: Session | null;
  signIn: (e: string, p: string) => Promise<TwoFactor | null>;
  verifyCode: (challengeId: string, code: string, remember: boolean) => Promise<void>;
  resendCode: (challengeId: string) => Promise<unknown>;
  signOut: () => Promise<void>;
}

export function AccountScreen({ nav, auth }: { nav: Nav; auth: Auth }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bookings, setBookings] = useState<any[]>([]);
  const [challenge, setChallenge] = useState<TwoFactor | null>(null);
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [notice, setNotice] = useState("");
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => { if (auth.session) api<any[]>("/auth/my-bookings").then(setBookings).catch(() => {}); }, [auth.session]);

  // Second step: the 6-digit code emailed to the account (passkeys are used on the website).
  if (!auth.session && challenge) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <H size={24}>Check it's you</H>
        <ErrorText>{error}</ErrorText>
        {notice ? <P small>{notice}</P> : null}
        {challenge.codeSent || challenge.methods.includes("email") ? (
          <>
            <P>{challenge.codeSent ? `We emailed a 6-digit code to ${challenge.email}. It expires in 10 minutes.` : "Get a code by email to finish signing in."}</P>
            {challenge.codeSent && <Input label="Code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={7} value={code} onChangeText={setCode} />}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 8 }}>
              <Switch value={remember} onValueChange={setRemember} />
              <P small>Remember this phone for {challenge.rememberDays} days</P>
            </View>
            {challenge.codeSent && <Button primary busy={busy} title="Verify" onPress={() => attempt(() => auth.verifyCode(challenge.id, code, remember))} />}
            <Button title={challenge.codeSent ? "Send a new code" : "Email me a code"} onPress={() => attempt(async () => {
              await auth.resendCode(challenge.id);
              setChallenge({ ...challenge, codeSent: true }); setNotice(`Code sent to ${challenge.email}. Check your spam folder if you don't see it.`);
            })} />
          </>
        ) : (
          <P>Use your passkey on the website to sign in, then try again here.</P>
        )}
        <Button title="Start again" onPress={() => { setChallenge(null); setCode(""); setPassword(""); setError(""); }} />
      </ScrollView>
    );
  }

  if (!auth.session) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <H size={24}>Sign in</H>
        <ErrorText>{error}</ErrorText>
        <Input label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Input label="Password" secureTextEntry value={password} onChangeText={setPassword} />
        <Button primary busy={busy} title="Sign in" onPress={async () => {
          setBusy(true); setError("");
          try { setChallenge(await auth.signIn(email, password)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
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
