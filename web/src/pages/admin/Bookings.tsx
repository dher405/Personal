import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money, toCents } from "../../api";
import { useAction, useApi } from "../../hooks";
import { SlotPicker, type Slot } from "../../components/SlotPicker";
import { useBusiness } from "./AdminLayout";

const badge: Record<string, string> = { confirmed: "ok", pending_payment: "warn", requested: "warn", cancelled: "bad", no_show: "bad", completed: "" };

export function Bookings() {
  const { biz, reloadBiz } = useBusiness();
  const today = DateTime.now().setZone(biz.timezone);
  // "?status=requested" (from the alert email and the banner) shows every waiting request, however far ahead.
  const [params] = useSearchParams();
  const onlyRequests = params.get("status") === "requested";
  const [range, setRange] = useState({ from: today.toISODate()!, to: today.plus({ days: onlyRequests ? 365 : 14 }).toISODate()!, status: onlyRequests ? "requested" : "", q: "" });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const { data: bookings, reload } = useApi<any[]>(`/admin/${biz.id}/bookings?${qs}`);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [showSeries, setShowSeries] = useState(params.get("series") === "1");
  const action = useAction();

  const accept = (b: any) => action.run(async () => {
    await api(`/admin/${biz.id}/bookings/${b.id}/accept`, { method: "POST" });
    reload(); reloadBiz(); // updates the "asking to pay in person" banner
  });
  const decline = (b: any) => action.run(async () => {
    const reason = prompt(`Decline ${b.customerName}'s request? The time is released and they're emailed. Add a note for them (optional):`, "");
    if (reason === null) return;
    await api(`/admin/${biz.id}/bookings/${b.id}/decline`, { body: { reason: reason || undefined } });
    reload(); reloadBiz();
  });

  // An online booking whose meeting link couldn't be made: try again with the meeting tool, or use a pasted link.
  const meeting = (b: any, url?: string) => action.run(async () => {
    await api(`/admin/${biz.id}/bookings/${b.id}/meeting`, { body: url ? { url } : {} });
    reload();
  });

  const [cancelling, setCancelling] = useState<any>(null);
  const setStatus = (b: any, status: string) => {
    // Cancelling something paid asks how to handle the payment (refund, or keep it for a late cancellation).
    if (status === "cancelled" && b.payments.some((p: any) => ["paid", "partially_refunded"].includes(p.status))) return setCancelling(b);
    action.run(async () => {
      if (status === "cancelled" && !confirm(`Cancel this booking? ${b.customerName} is emailed.`)) return;
      await api(`/admin/${biz.id}/bookings/${b.id}`, { method: "PATCH", body: { status } });
      reload();
    });
  };

  return (
    <div className="stack">
      <div className="card row">
        <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <label>Status
          <select value={range.status} onChange={(e) => setRange({ ...range, status: e.target.value })}>
            <option value="">All</option>
            {["requested", "confirmed", "pending_payment", "completed", "cancelled", "no_show"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Search<input placeholder="Name, email, code" value={range.q} onChange={(e) => setRange({ ...range, q: e.target.value })} /></label>
        <div className="spacer" />
        <button onClick={() => setShowSeries(!showSeries)}>🔁 Repeating</button>
        <button className="primary" onClick={() => setCreating(true)}>+ New booking</button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
      {showSeries && <SeriesList onOpen={setSeriesId} />}
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
                  <td>{b.serviceName}<div className="small muted">{b.staffName}</div>
                    {b.meetingMode === "online" && (b.meetingUrl
                      ? <div className="small"><a href={b.meetingUrl} target="_blank" rel="noreferrer">💻 Join meeting</a></div>
                      : ["confirmed", "completed"].includes(b.status) && (
                        <div className="small">
                          <span style={{ color: "var(--warn)" }} title={b.meetingError ?? ""}>⚠ No meeting link{b.meetingError ? `: ${b.meetingError}` : ""}</span>
                          <div className="row" style={{ gap: 6, marginTop: 4 }}>
                            <button className="small" onClick={() => meeting(b)}>Retry</button>
                            <button className="small" onClick={() => { const url = prompt("Paste the meeting link to send the customer:"); if (url) meeting(b, url); }}>Paste link</button>
                          </div>
                        </div>
                      ))}
                    {b.meetingMode === "online" && !b.meetingUrl && !["confirmed", "completed"].includes(b.status) && <div className="small muted">💻 Online</div>}
                  </td>
                  <td>{money(b.priceCents, b.currency)}
                    {paid.map((p: any) => <div key={p.id} className="small muted">paid {money(p.amount_cents, b.currency)}{p.refunded_cents ? `, refunded ${money(p.refunded_cents, b.currency)}` : ""}</div>)}
                  </td>
                  <td>
                    <span className={`badge ${badge[b.status]}`}>{b.status === "requested" ? "request" : b.status.replace("_", " ")}</span>
                    {b.payInPerson && <div className="small">💵 pays in person</div>}
                    {b.keptPayment && <div className="small muted">late cancellation: payment kept</div>}
                    {b.refundError && <div className="small" style={{ color: "var(--bad)" }} title={b.refundError}>⚠ Automatic refund failed: {b.refundError}. Refund it from Edit / move, or in your payment provider.</div>}
                    {b.customerConfirmedAt && b.status === "confirmed" && <div className="small" title="Customer confirmed attendance">✓ customer confirmed</div>}
                    {b.smsOptIn && <div className="small muted">📱 texts on</div>}
                    {b.series && <div className="small"><button className="link" onClick={() => setSeriesId(b.series.id)}>🔁 every {b.series.intervalWeeks === 1 ? "week" : "2 weeks"}</button></div>}
                  </td>
                  <td>
                    <div className="row">
                      {b.status === "requested" && <>
                        <button className="primary" onClick={() => accept(b)}>Accept</button>
                        <button className="danger" onClick={() => decline(b)}>Decline</button>
                      </>}
                      <button onClick={() => setEditing(b)}>Edit / move</button>
                      {b.status === "confirmed" && b.smsOptIn && biz.sms_ready ? (
                        <button onClick={() => action.run(async () => { await api(`/admin/${biz.id}/bookings/${b.id}/sms-reminder`, { method: "POST" }); reload(); })}>Text reminder</button>
                      ) : null}
                      {b.status === "confirmed" && <button onClick={() => setStatus(b, "completed")}>Done</button>}
                      {b.status === "confirmed" && <button onClick={() => setStatus(b, "no_show")}>No-show</button>}
                      {!["cancelled", "requested"].includes(b.status) && <button className="danger" onClick={() => setStatus(b, "cancelled")}>Cancel</button>}
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
      {cancelling && <CancelBooking booking={cancelling} onClose={() => { setCancelling(null); reload(); }} />}
      {creating && <NewBooking onClose={() => { setCreating(false); reload(); reloadBiz(); }} />}
      {seriesId && <SeriesModal id={seriesId} onClose={() => { setSeriesId(null); reload(); reloadBiz(); }} />}
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
  const [form, setForm] = useState({ name: "", email: "", phone: "", price: "", smsOptIn: false, meetingMode: "in_person" });
  const [repeat, setRepeat] = useState({ interval: 0, weeks: biz.recurring_weeks ?? 26 });
  const [result, setResult] = useState<any>(null);
  const action = useAction();
  const service = services?.find((s) => s.id === serviceId);

  const save = () => action.run(async () => {
    const created = await api<any>(`/admin/${biz.id}/bookings`, {
      body: {
        serviceId, staffId: slot!.staffId, start: slot!.start, name: form.name, email: form.email,
        phone: form.phone || undefined, priceCents: form.price ? toCents(form.price) : undefined, smsOptIn: form.smsOptIn && !!form.phone,
        meetingMode: service?.location_mode === "choice" ? form.meetingMode : undefined,
        repeat: repeat.interval ? { intervalWeeks: repeat.interval, weeks: Number(repeat.weeks) } : undefined,
      },
    });
    if (created.seriesResult) setResult(created.seriesResult);
    else onClose();
  });

  if (result) {
    return (
      <div className="modal-bg" onClick={onClose}>
        <div className="modal stack" onClick={(e) => e.stopPropagation()}>
          <h2>🔁 {result.created} lessons booked</h2>
          <p>{form.name} has been emailed the full list of dates, with one calendar file for all of them.</p>
          {result.skipped.length > 0 && <>
            <p className="small"><b>These weeks weren't free</b>, so they were left out. Book them by hand at another time if needed:</p>
            <ul className="small">{result.skipped.map((s: any) => <li key={s.start}>{DateTime.fromISO(s.start).setZone(biz.timezone).toFormat("ccc d LLL yyyy, h:mm a")} — {s.reason}</li>)}</ul>
          </>}
          <div className="row"><button className="primary" onClick={onClose}>Done</button></div>
        </div>
      </div>
    );
  }

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
        {service?.location_mode === "choice" && (
          <label>Where
            <select value={form.meetingMode} onChange={(e) => setForm({ ...form, meetingMode: e.target.value })}>
              <option value="in_person">In person</option><option value="online">Online (a meeting link is sent)</option>
            </select>
          </label>
        )}
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
        <div className="form-grid">
          <label>Repeat
            <select value={repeat.interval} onChange={(e) => setRepeat({ ...repeat, interval: Number(e.target.value) })}>
              <option value={0}>Doesn't repeat</option><option value={1}>Every week</option><option value={2}>Every 2 weeks</option>
            </select>
          </label>
          {repeat.interval > 0 && <label>For (weeks)<input type="number" min={2} max={52} value={repeat.weeks} onChange={(e) => setRepeat({ ...repeat, weeks: e.target.value as any })} /></label>}
        </div>
        {repeat.interval > 0 && <p className="small muted">Same day and time {repeat.interval === 1 ? "every week" : "every other week"} for {repeat.weeks} weeks. Weeks that are already taken are skipped and listed. Two weeks before the last lesson, you and the customer are reminded so it can be renewed.</p>}
        <div className="row"><button className="primary" disabled={!slot || !form.name || !form.email || action.busy} onClick={save}>{repeat.interval ? "Create lessons" : "Create booking"}</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}

const when = (iso: string, zone: string, fmt = "ccc d LLL yyyy") => DateTime.fromISO(iso).setZone(zone).toFormat(fmt);

function SeriesList({ onOpen }: { onOpen: (id: string) => void }) {
  const { biz } = useBusiness();
  const { data: series } = useApi<any[]>(`/admin/${biz.id}/series`);
  return (
    <div className="card table-wrap">
      <h3 style={{ marginTop: 0 }}>🔁 Repeating bookings</h3>
      <table>
        <thead><tr><th>Customer</th><th>Service</th><th>Repeats</th><th>Last lesson</th><th /></tr></thead>
        <tbody>
          {series?.map((s) => (
            <tr key={s.id}>
              <td>{s.customer_name}<div className="small muted">{s.customer_email}</div></td>
              <td>{s.service_name}<div className="small muted">{s.staff_name}</div></td>
              <td>Every {s.interval_weeks === 1 ? "week" : "2 weeks"}<div className="small muted">{s.upcoming} to come</div></td>
              <td>{when(s.last_start, biz.timezone)}{s.ending_soon && <div className="small" style={{ color: "var(--warn)" }}>Ends soon{s.reminder_sent_at ? " · renewal link sent" : ""}</div>}</td>
              <td><button onClick={() => onOpen(s.id)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {series?.length === 0 && <p className="muted">No repeating bookings yet. Choose “Repeat” when you make a booking.</p>}
    </div>
  );
}

function SeriesModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { biz } = useBusiness();
  const { data: s, reload } = useApi<any>(`/admin/${biz.id}/series/${id}`);
  const [message, setMessage] = useState("");
  const action = useAction();
  const now = DateTime.utc();

  const renew = () => action.run(async () => {
    if (!confirm(`Add the next ${s.weeks} weeks after ${when(s.last_start, biz.timezone)}? ${s.customer_name} is emailed the new dates.`)) return;
    const r = await api<any>(`/admin/${biz.id}/series/${id}/renew`, { method: "POST" });
    setMessage(`${r.added} lessons added.${r.skipped.length ? ` ${r.skipped.length} week(s) weren't free and were skipped: ${r.skipped.map((k: any) => when(k.start, biz.timezone, "d LLL")).join(", ")}.` : ""}`);
    reload();
  });
  const cancel = () => action.run(async () => {
    if (!confirm(`Cancel all of ${s.customer_name}'s remaining lessons? They get one email, and anything paid for those lessons is refunded automatically.`)) return;
    const r = await api<any>(`/admin/${biz.id}/series/${id}/cancel`, { method: "POST" });
    setMessage(`${r.cancelled} lessons cancelled.`);
    reload();
  });

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        {!s ? <p className="muted">Loading…</p> : <>
          <h2>🔁 {s.customer_name}, every {s.interval_weeks === 1 ? "week" : "2 weeks"}</h2>
          <p className="small muted">{s.customer_email}{s.customer_phone ? ` · ${s.customer_phone}` : ""} · status: {s.status} · last lesson {when(s.last_start, biz.timezone)}</p>
          {s.endsSoon && <div className="notice" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>This series ends soon.{s.reminder_sent_at ? " The customer has been emailed a link to renew." : ""}</div>}
          {message && <div className="notice">{message}</div>}
          {action.error && <div className="error">{action.error}</div>}
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            <table>
              <tbody>
                {s.lessons.map((l: any) => (
                  <tr key={l.id} style={{ opacity: DateTime.fromISO(l.starts_at) < now ? 0.55 : 1 }}>
                    <td>{when(l.starts_at, biz.timezone, "ccc d LLL yyyy, h:mm a")}</td><td className="small muted">{l.code}</td>
                    <td><span className={`badge ${badge[l.status]}`}>{l.status.replace("_", " ")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">To move or cancel one lesson, use Edit / move or Cancel on it in the bookings list.</p>
          <div className="row">
            {s.status !== "cancelled" && <button className="primary" disabled={action.busy} onClick={renew}>Renew for {s.weeks} more weeks</button>}
            {s.status === "active" && <button className="danger" disabled={action.busy} onClick={cancel}>Cancel remaining lessons</button>}
            <button onClick={onClose}>Close</button>
          </div>
        </>}
      </div>
    </div>
  );
}

/** Cancelling a paid booking: refund it in full, or (for a late cancellation) keep the payment. */
function CancelBooking({ booking: b, onClose }: { booking: any; onClose: () => void }) {
  const { biz } = useBusiness();
  const action = useAction();
  const paid = b.payments.filter((p: any) => ["paid", "partially_refunded"].includes(p.status)).reduce((n: number, p: any) => n + p.amount_cents - p.refunded_cents, 0);
  const late = DateTime.fromISO(b.start).diffNow("hours").hours < biz.cancellation_hours;
  const cancel = (keepPayment: boolean) => action.run(async () => {
    await api(`/admin/${biz.id}/bookings/${b.id}`, { method: "PATCH", body: { status: "cancelled", keepPayment } });
    onClose();
  });
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h2>Cancel {b.customerName}'s booking?</h2>
        <p>{b.serviceName}, {DateTime.fromISO(b.start).setZone(biz.timezone).toFormat("ccc d LLL, h:mm a")}. They paid {money(paid, b.currency)}, and they're emailed either way.</p>
        {action.error && <div className="error">{action.error}</div>}
        <button className="primary" disabled={action.busy} onClick={() => cancel(false)}>Cancel and refund {money(paid, b.currency)}</button>
        {late ? (
          <>
            <button className="danger" disabled={action.busy} onClick={() => cancel(true)}>Cancel and keep the payment (late cancellation)</button>
            <p className="small muted">This is within your {biz.cancellation_hours}-hour cancellation window, so you can keep the payment. The email tells them it isn't refunded under your cancellation policy.</p>
          </>
        ) : (
          <p className="small muted">This is more than {biz.cancellation_hours} hours away, so cancelling refunds them in full. To keep the payment, move the booking to another time instead (Edit / move).</p>
        )}
        <button disabled={action.busy} onClick={onClose}>Don't cancel</button>
      </div>
    </div>
  );
}
