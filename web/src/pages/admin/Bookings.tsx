import { useState } from "react";
import { DateTime } from "luxon";
import { api, money, toCents } from "../../api";
import { useAction, useApi } from "../../hooks";
import { SlotPicker, type Slot } from "../../components/SlotPicker";
import { useBusiness } from "./AdminLayout";

const badge: Record<string, string> = { confirmed: "ok", pending_payment: "warn", cancelled: "bad", no_show: "bad", completed: "" };

export function Bookings() {
  const { biz } = useBusiness();
  const today = DateTime.now().setZone(biz.timezone);
  const [range, setRange] = useState({ from: today.toISODate()!, to: today.plus({ days: 14 }).toISODate()!, status: "", q: "" });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const { data: bookings, reload } = useApi<any[]>(`/admin/${biz.id}/bookings?${qs}`);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const action = useAction();

  const setStatus = (b: any, status: string) => action.run(async () => {
    if (status === "cancelled" && !confirm("Cancel this booking? Refunds are issued separately.")) return;
    await api(`/admin/${biz.id}/bookings/${b.id}`, { method: "PATCH", body: { status } });
    reload();
  });

  return (
    <div className="stack">
      <div className="card row">
        <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <label>Status
          <select value={range.status} onChange={(e) => setRange({ ...range, status: e.target.value })}>
            <option value="">All</option>
            {["confirmed", "pending_payment", "completed", "cancelled", "no_show"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Search<input placeholder="Name, email, code" value={range.q} onChange={(e) => setRange({ ...range, q: e.target.value })} /></label>
        <div className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>+ New booking</button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>When</th><th>Customer</th><th>Service</th><th>Price / paid</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {bookings?.map((b) => {
              const paid = b.payments.filter((p: any) => ["paid", "partially_refunded", "refunded"].includes(p.status));
              return (
                <tr key={b.id}>
                  <td>{DateTime.fromISO(b.start).setZone(biz.timezone).toFormat("ccc d LLL, h:mm a")}<div className="small muted">{b.code} · {b.source}</div></td>
                  <td>{b.customerName}<div className="small muted">{b.customerEmail}{b.customerPhone ? ` · ${b.customerPhone}` : ""}</div></td>
                  <td>{b.serviceName}<div className="small muted">{b.staffName}</div></td>
                  <td>{money(b.priceCents, b.currency)}
                    {paid.map((p: any) => <div key={p.id} className="small muted">paid {money(p.amount_cents, b.currency)}{p.refunded_cents ? `, refunded ${money(p.refunded_cents, b.currency)}` : ""}</div>)}
                  </td>
                  <td>
                    <span className={`badge ${badge[b.status]}`}>{b.status.replace("_", " ")}</span>
                    {b.customerConfirmedAt && b.status === "confirmed" && <div className="small" title="Customer confirmed attendance">✓ customer confirmed</div>}
                    {b.smsOptIn && <div className="small muted">📱 texts on</div>}
                  </td>
                  <td>
                    <div className="row">
                      <button onClick={() => setEditing(b)}>Edit / move</button>
                      {b.status === "confirmed" && b.smsOptIn && biz.sms_ready ? (
                        <button onClick={() => action.run(async () => { await api(`/admin/${biz.id}/bookings/${b.id}/sms-reminder`, { method: "POST" }); reload(); })}>Text reminder</button>
                      ) : null}
                      {b.status === "confirmed" && <button onClick={() => setStatus(b, "completed")}>Done</button>}
                      {b.status === "confirmed" && <button onClick={() => setStatus(b, "no_show")}>No-show</button>}
                      {b.status !== "cancelled" && <button className="danger" onClick={() => setStatus(b, "cancelled")}>Cancel</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {bookings?.length === 0 && <p className="muted">No bookings in this range.</p>}
      </div>
      {editing && <EditBooking booking={editing} onClose={() => { setEditing(null); reload(); }} />}
      {creating && <NewBooking onClose={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function EditBooking({ booking: b, onClose }: { booking: any; onClose: () => void }) {
  const { biz } = useBusiness();
  const { data: staff } = useApi<any[]>(`/admin/${biz.id}/staff`);
  const [staffId, setStaffId] = useState(b.staffId);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [force, setForce] = useState(false);
  const [manualStart, setManualStart] = useState(DateTime.fromISO(b.start).setZone(biz.timezone).toFormat("yyyy-LL-dd'T'HH:mm"));
  const [price, setPrice] = useState((b.priceCents / 100).toFixed(2));
  const [notes, setNotes] = useState(b.notes);
  const [refunds, setRefunds] = useState<Record<string, string>>({});
  const action = useAction();

  const save = () => action.run(async () => {
    const body: any = { priceCents: toCents(price), notes };
    if (force) Object.assign(body, { start: DateTime.fromISO(manualStart, { zone: biz.timezone }).toUTC().toISO(), staffId, force: true });
    else if (slot) Object.assign(body, { start: slot.start, staffId: slot.staffId });
    await api(`/admin/${biz.id}/bookings/${b.id}`, { method: "PATCH", body });
    onClose();
  });

  const refund = (p: any) => action.run(async () => {
    const amount = refunds[p.id] ? toCents(refunds[p.id]) : undefined;
    if (!confirm(`Refund ${amount ? money(amount, b.currency) : "the full remaining amount"} to ${b.customerName}?`)) return;
    await api(`/admin/${biz.id}/payments/${p.id}/refund`, { body: { amountCents: amount, reason: "Admin refund" } });
    onClose();
  });

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h2>{b.customerName} — {b.serviceName}</h2>
        {action.error && <div className="error">{action.error}</div>}
        <h3>Move</h3>
        <label>Staff
          <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
            {staff?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="inline"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Override availability (book any time)</label>
        {force ? (
          <label>New start ({biz.timezone})<input type="datetime-local" value={manualStart} onChange={(e) => setManualStart(e.target.value)} /></label>
        ) : (
          <SlotPicker timezone={biz.timezone} selected={slot} onPick={setSlot} initialDay={DateTime.fromISO(b.start).setZone(biz.timezone).toISODate()!}
            slotsPath={(day) => `/admin/${biz.id}/slots?serviceId=${b.serviceId}&from=${day}&staffId=${staffId}&excludeBookingId=${b.id}`} />
        )}
        <h3>Price & notes</h3>
        <label>Price ({b.currency})<input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        {b.payments.some((p: any) => ["paid", "partially_refunded"].includes(p.status)) && <h3>Refunds</h3>}
        {b.payments.filter((p: any) => ["paid", "partially_refunded"].includes(p.status)).map((p: any) => (
          <div key={p.id} className="row">
            <span className="small">{p.provider}: {money(p.amount_cents - p.refunded_cents, b.currency)} refundable</span>
            <input style={{ width: 110 }} type="number" step="0.01" placeholder="Full" value={refunds[p.id] ?? ""} onChange={(e) => setRefunds({ ...refunds, [p.id]: e.target.value })} />
            <button className="danger" disabled={action.busy} onClick={() => refund(p)}>Refund</button>
          </div>
        ))}
        <div className="row"><button className="primary" disabled={action.busy} onClick={save}>Save changes</button><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function NewBooking({ onClose }: { onClose: () => void }) {
  const { biz } = useBusiness();
  const { data: services } = useApi<any[]>(`/admin/${biz.id}/services`);
  const [serviceId, setServiceId] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", price: "", smsOptIn: false });
  const action = useAction();
  const service = services?.find((s) => s.id === serviceId);

  const save = () => action.run(async () => {
    await api(`/admin/${biz.id}/bookings`, {
      body: {
        serviceId, staffId: slot!.staffId, start: slot!.start, name: form.name, email: form.email,
        phone: form.phone || undefined, priceCents: form.price ? toCents(form.price) : undefined, smsOptIn: form.smsOptIn && !!form.phone,
      },
    });
    onClose();
  });

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h2>New booking</h2>
        {action.error && <div className="error">{action.error}</div>}
        <label>Service
          <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setSlot(null); }}>
            <option value="">Choose…</option>
            {services?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} — {money(s.price_cents, biz.currency)}</option>)}
          </select>
        </label>
        {service && <SlotPicker timezone={biz.timezone} selected={slot} onPick={setSlot} showStaff slotsPath={(day) => `/admin/${biz.id}/slots?serviceId=${serviceId}&from=${day}`} />}
        <div className="form-grid">
          <label>Customer name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>Custom price<input type="number" step="0.01" placeholder={service ? (service.price_cents / 100).toFixed(2) : ""} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
        </div>
        {biz.sms_ready ? (
          <label className="inline small"><input type="checkbox" checked={form.smsOptIn} disabled={!form.phone} onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })} /> Customer agreed to text reminders</label>
        ) : null}
        <div className="row"><button className="primary" disabled={!slot || !form.name || !form.email || action.busy} onClick={save}>Create booking</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
