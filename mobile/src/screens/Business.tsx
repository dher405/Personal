import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { DateTime } from "luxon";
import { api, money } from "../api";
import { Button, Card, ErrorText, H, Input, P, useTheme } from "../ui";
import type { Nav, Session } from "../../App";

interface Slot { start: string; staffId: string; staffName: string }

export function BusinessScreen({ nav, slug, session }: { nav: Nav; slug: string; session: Session | null }) {
  const t = useTheme();
  const [biz, setBiz] = useState<any>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [day, setDay] = useState(DateTime.now().toISODate()!);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: session?.user.name ?? "", email: session?.user.email ?? "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);

  useEffect(() => { api(`/public/businesses/${slug}`).then(setBiz).catch((e) => setError(e.message)); }, [slug]);
  useEffect(() => {
    if (!serviceId) return;
    setSlots(null); setSlot(null);
    api<Slot[]>(`/public/businesses/${slug}/slots?serviceId=${serviceId}&from=${day}`).then(setSlots).catch((e) => setError(e.message));
  }, [serviceId, day]);

  const days = useMemo(() => {
    if (!biz) return [];
    const today = DateTime.now().setZone(biz.timezone).startOf("day");
    return Array.from({ length: 14 }, (_, i) => today.plus({ days: i }));
  }, [biz]);

  if (!biz) return <View style={{ padding: 16 }}><ErrorText>{error}</ErrorText><P muted>Loading…</P></View>;
  const service = biz.services.find((s: any) => s.id === serviceId);
  const fmt = (iso: string, f: string) => DateTime.fromISO(iso).setZone(biz.timezone).toFormat(f);

  const book = async () => {
    setBusy(true); setError("");
    try {
      const res = await api(`/public/businesses/${slug}/bookings`, {
        body: { serviceId, staffId: slot!.staffId, start: slot!.start, name: form.name, email: form.email, phone: form.phone || undefined, source: "mobile" },
      });
      setDone(res.booking);
      if (res.paymentUrl) Linking.openURL(res.paymentUrl);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Card>
          <H>{done.status === "pending_payment" ? "Almost done — finish payment" : "You're booked!"}</H>
          <P>{done.serviceName} with {done.staffName}</P>
          <P>{fmt(done.start, "cccc d LLLL, h:mm a")}</P>
          <P muted small>Code {done.code} · confirmation sent to {done.customerEmail}</P>
          <Button title="Manage booking" onPress={() => Linking.openURL(done.manageUrl)} />
          <Button title="Done" onPress={nav.back} />
        </Card>
      </ScrollView>
    );
  }

  const chip = (selected: boolean) => ({ borderWidth: 1, borderRadius: 10, padding: 10, marginRight: 8, marginBottom: 8, borderColor: selected ? t.accent : t.border, backgroundColor: selected ? t.accent : t.surface });
  const chipText = (selected: boolean) => ({ color: selected ? t.accentText : t.text, fontWeight: "600" as const, textAlign: "center" as const });

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={nav.back}><Text style={{ color: t.accent, marginBottom: 8 }}>‹ Back</Text></Pressable>
      <H size={24}>{biz.name}</H>
      <P muted>{biz.description}</P>
      {biz.aiChat && <Button title="💬 Book by chatting with our assistant" onPress={() => nav.go({ name: "chat", slug, businessName: biz.name })} />}
      <ErrorText>{error}</ErrorText>

      <H size={17}>Choose a service</H>
      {biz.services.map((s: any) => (
        <Pressable key={s.id} onPress={() => setServiceId(s.id)}>
          <View style={[chip(s.id === serviceId), { flexDirection: "row", justifyContent: "space-between", marginRight: 0 }]}>
            <Text style={chipText(s.id === serviceId)}>{s.name}</Text>
            <Text style={chipText(s.id === serviceId)}>{s.price_cents ? money(s.price_cents, biz.currency) : "Free"}</Text>
          </View>
        </Pressable>
      ))}

      {service && (
        <>
          <H size={17}>Pick a day</H>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            {days.map((d) => (
              <Pressable key={d.toISODate()} onPress={() => setDay(d.toISODate()!)} style={[chip(d.toISODate() === day), { width: 58 }]}>
                <Text style={chipText(d.toISODate() === day)}>{d.toFormat("ccc")}{"\n"}{d.toFormat("d")}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {slots === null ? <P muted>Loading times…</P> : slots.length === 0 ? <P muted>No open times — try another day.</P> : slots.map((s) => {
              const sel = slot?.start === s.start && slot.staffId === s.staffId;
              return (
                <Pressable key={s.start + s.staffId} onPress={() => setSlot(s)} style={chip(sel)}>
                  <Text style={chipText(sel)}>{fmt(s.start, "h:mm a")}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {slot && (
        <Card>
          <P>{service.name} with {slot.staffName}, {fmt(slot.start, "ccc d LLL, h:mm a")}</P>
          <View style={{ height: 10 }} />
          <Input label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} />
          <Input label="Email" keyboardType="email-address" autoCapitalize="none" value={form.email} onChangeText={(email) => setForm({ ...form, email })} />
          <Input label="Phone (optional)" keyboardType="phone-pad" value={form.phone} onChangeText={(phone) => setForm({ ...form, phone })} />
          <Button primary busy={busy} disabled={!form.name || !form.email} title={biz.requirePayment && service.price_cents ? "Continue to payment" : "Confirm booking"} onPress={book} />
        </Card>
      )}
    </ScrollView>
  );
}
