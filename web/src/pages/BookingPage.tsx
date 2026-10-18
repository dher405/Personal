import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money } from "../api";
import { useAuth } from "../auth";
import { useAction, useApi } from "../hooks";
import { SlotPicker, type Slot } from "../components/SlotPicker";
import { ChatWidget } from "../components/ChatWidget";

export function BookingPage() {
  const { slug } = useParams();
  const { session } = useAuth();
  const { data: biz, error } = useApi<any>(`/public/businesses/${slug}`);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [details, setDetails] = useState({ name: session?.user.name ?? "", email: session?.user.email ?? "", phone: "", notes: "" });
  const [done, setDone] = useState<any>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const { busy, error: bookError, run } = useAction();

  if (error) return <div className="container"><div className="error">{error}</div></div>;
  if (!biz) return <div className="container muted">Loading…</div>;

  const service = biz.services.find((s: any) => s.id === serviceId);
  const staffForService = biz.staff.filter((s: any) => s.service_ids.includes(serviceId));

  const book = () => run(async () => {
    const res = await api(`/public/businesses/${slug}/bookings`, {
      body: { serviceId, staffId: slot!.staffId, start: slot!.start, ...details, phone: details.phone || undefined, notes: details.notes || undefined },
    });
    if (res.paymentUrl) window.location.href = res.paymentUrl;
    else setDone(res.booking);
  });

  if (done) {
    return (
      <div className="container narrow">
        <div className="card stack">
          <h1>You're booked!</h1>
          <p>{done.serviceName} with {done.staffName}<br />
            <strong>{DateTime.fromISO(done.start).setZone(biz.timezone).toLocaleString(DateTime.DATETIME_HUGE)}</strong></p>
          <p>Booking code: <strong>{done.code}</strong>. A confirmation goes to {done.customerEmail}.</p>
          <Link to={`/manage/${done.manageToken}`} className="btn">Manage or reschedule</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>{biz.name}</h1>
        <p className="muted">{biz.description}</p>
        <div className="small muted">{[biz.address, biz.phone].filter(Boolean).join(" · ")}</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div className="card stack">
          <h2>1. Choose a service</h2>
          {biz.services.map((s: any) => (
            <button key={s.id} className={`pick ${s.id === serviceId ? "selected" : ""}`} onClick={() => { setServiceId(s.id); setSlot(null); setStaffId(""); }}>
              <span><strong>{s.name}</strong><br /><span className="muted small">{s.duration_min} min{s.description ? ` · ${s.description}` : ""}</span></span>
              <strong>{s.price_cents ? money(s.price_cents, biz.currency) : "Free"}</strong>
            </button>
          ))}
        </div>

        {service && (
          <div className="card stack">
            <h2>2. Pick a time</h2>
            {staffForService.length > 1 && (
              <label>With
                <select value={staffId} onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
                  <option value="">Anyone available</option>
                  {staffForService.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <SlotPicker
              timezone={biz.timezone}
              selected={slot}
              onPick={setSlot}
              showStaff={!staffId && staffForService.length > 1}
              slotsPath={(day) => `/public/businesses/${slug}/slots?serviceId=${serviceId}&from=${day}${staffId ? `&staffId=${staffId}` : ""}`}
            />
          </div>
        )}

        {slot && (
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); book(); }}>
            <h2>3. Your details</h2>
            <p>{service.name} with {slot.staffName} — <strong>{DateTime.fromISO(slot.start).setZone(biz.timezone).toLocaleString(DateTime.DATETIME_MED_WITH_WEEKDAY)}</strong></p>
            {bookError && <div className="error">{bookError}</div>}
            <div className="form-grid">
              <label>Name<input required value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></label>
              <label>Email<input type="email" required value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} /></label>
              <label>Phone (optional)<input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></label>
            </div>
            <label>Notes (optional)<textarea value={details.notes} onChange={(e) => setDetails({ ...details, notes: e.target.value })} /></label>
            <p className="small muted">Free cancellation up to {biz.cancellationHours}h before.</p>
            <button className="primary" disabled={busy}>
              {biz.requirePayment && service.price_cents > 0 ? `Continue to payment (${money(service.deposit_cents || service.price_cents, biz.currency)})` : "Confirm booking"}
            </button>
          </form>
        )}
      </div>

      {biz.aiChat && (
        <>
          {chatOpen && (
            <div className="card chat-panel">
              <ChatWidget
                endpoint={`/public/businesses/${slug}/chat`}
                storageKey={`chat:${slug}`}
                greeting={`Hi! I'm ${biz.name}'s booking assistant. What would you like to book? I can also move or cancel an existing appointment.`}
              />
            </div>
          )}
          <button className="primary chat-fab" onClick={() => setChatOpen(!chatOpen)}>{chatOpen ? "Close chat" : "💬 Book by chat"}</button>
        </>
      )}
    </div>
  );
}
