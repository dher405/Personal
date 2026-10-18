import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { DateTime } from "luxon";
import { api, money } from "../api";
import { Button, Card, ErrorText, H, Input, P, useTheme } from "../ui";
import type { Nav } from "../../App";

/** On-the-go admin: upcoming bookings with complete / no-show / cancel / move / refund. */
export function AdminScreen({ nav, businessId }: { nav: Nav; businessId: string }) {
  const t = useTheme();
  const [biz, setBiz] = useState<any>(null);
  const [bookings, setBookings] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const b = await api(`/admin/${businessId}`);
      setBiz(b);
      const from = DateTime.now().setZone(b.timezone).toISODate();
      const to = DateTime.now().setZone(b.timezone).plus({ days: 14 }).toISODate();
      setBookings(await api(`/admin/${businessId}/bookings?from=${from}&to=${to}`));
    } catch (e) { setError((e as Error).message); } finally { setRefreshing(false); }
  }, [businessId]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const setStatus = (b: any, status: string) => act(() => api(`/admin/${businessId}/bookings/${b.id}`, { method: "PATCH", body: { status } }));

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}>
      <Pressable onPress={nav.back}><Text style={{ color: t.accent, marginBottom: 8 }}>‹ Back</Text></Pressable>
      <H size={24}>{biz?.name ?? "Bookings"}</H>
      <P muted small>Next 14 days · pull to refresh. Full controls (services, hours, payments, plans) are on the web admin.</P>
      <ErrorText>{error}</ErrorText>
      {bookings.length === 0 && !refreshing && <P muted>Nothing booked.</P>}
      {bookings.map((b) => (
        <Card key={b.id}>
          <Pressable onPress={() => setOpen(open === b.id ? null : b.id)}>
            <H size={16}>{DateTime.fromISO(b.start).setZone(biz?.timezone).toFormat("ccc d LLL, h:mm a")}</H>
            <P>{b.customerName} — {b.serviceName}</P>
            <P muted small>{b.staffName} · {money(b.priceCents, b.currency)} · {b.status.replace("_", " ")}</P>
          </Pressable>
          {open === b.id && <BookingActions b={b} businessId={businessId} zone={biz?.timezone} act={act} setStatus={setStatus} />}
        </Card>
      ))}
    </ScrollView>
  );
}

function BookingActions({ b, businessId, zone, act, setStatus }: { b: any; businessId: string; zone: string; act: (fn: () => Promise<unknown>) => void; setStatus: (b: any, s: string) => void }) {
  const [newTime, setNewTime] = useState(DateTime.fromISO(b.start).setZone(zone).toFormat("yyyy-LL-dd HH:mm"));
  const [price, setPrice] = useState((b.priceCents / 100).toFixed(2));
  const paid = b.payments.filter((p: any) => ["paid", "partially_refunded"].includes(p.status));
  return (
    <View style={{ marginTop: 10 }}>
      {b.customerPhone && <P small>📞 {b.customerPhone}</P>}
      <P small>✉️ {b.customerEmail}</P>
      <View style={{ height: 8 }} />
      <Input label={`Move to (${zone}, YYYY-MM-DD HH:mm)`} value={newTime} onChangeText={setNewTime} />
      <Button title="Move booking" onPress={() => act(() => api(`/admin/${businessId}/bookings/${b.id}`, {
        method: "PATCH", body: { start: DateTime.fromFormat(newTime, "yyyy-LL-dd HH:mm", { zone }).toUTC().toISO() },
      }))} />
      <Input label="Price" keyboardType="decimal-pad" value={price} onChangeText={setPrice} />
      <Button title="Update price" onPress={() => act(() => api(`/admin/${businessId}/bookings/${b.id}`, { method: "PATCH", body: { priceCents: Math.round(parseFloat(price) * 100) } }))} />
      {b.status === "confirmed" && <Button title="Mark completed" onPress={() => setStatus(b, "completed")} />}
      {b.status === "confirmed" && <Button title="Mark no-show" onPress={() => setStatus(b, "no_show")} />}
      {paid.map((p: any) => (
        <Button key={p.id} danger title={`Refund ${money(p.amount_cents - p.refunded_cents, b.currency)}`} onPress={() =>
          Alert.alert("Refund", "Refund the full remaining amount?", [
            { text: "Cancel", style: "cancel" },
            { text: "Refund", style: "destructive", onPress: () => act(() => api(`/admin/${businessId}/payments/${p.id}/refund`, { body: { reason: "Mobile admin refund" } })) },
          ])} />
      ))}
      {b.status !== "cancelled" && <Button danger title="Cancel booking" onPress={() =>
        Alert.alert("Cancel booking?", "Refunds are issued separately.", [
          { text: "Keep" }, { text: "Cancel booking", style: "destructive", onPress: () => setStatus(b, "cancelled") },
        ])} />}
    </View>
  );
}
