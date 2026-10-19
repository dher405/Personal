import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money } from "../api";
import { useAuth } from "../auth";
import { useAction, useApi } from "../hooks";
import { SlotPicker, type Slot } from "../components/SlotPicker";
import { ChatWidget } from "../components/ChatWidget";
import { AddToCalendar } from "../components/AddToCalendar";

/** Tells the page that embeds us (embed.js) how tall we are, so its iframe never shows a scrollbar. */
function useReportHeight(enabled: boolean) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;
    // The body's own height, not the document's: the document is never shorter than the frame, so it could only grow.
    const send = () => window.parent.postMessage({ type: "slotwise:height", height: Math.ceil(document.body.getBoundingClientRect().height) }, "*");
    const observer = new ResizeObserver(send);
    observer.observe(document.body);
    send();
    return () => observer.disconnect();
  }, [enabled]);
}

/**
 * The public booking page. `embed` = shown inside a business's own website (via /embed/:slug):
 * no site header, chat inline instead of floating, and payment/manage links open a new tab
 * because checkout pages refuse to run inside someone else's page.
 */
export function BookingPage({ embed = false }: { embed?: boolean }) {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const { session } = useAuth();
  const { data: biz, error } = useApi<any>(`/public/businesses/${slug}`);
  const [serviceId, setServiceId] = useState<string | null>(params.get("service"));
  const [pendingPayment, setPendingPayment] = useState<{ url: string; booking: any } | null>(null);
  useReportHeight(embed);
  useEffect(() => {
    if (!embed) return;
    const root = document.documentElement;
    root.dataset.embed = "1";
    root.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
    if (params.get("color")?.match(/^#?[0-9a-f]{6}$/i)) {
      const c = `#${params.get("color")!.replace("#", "")}`;
      root.style.setProperty("--accent", c);
      root.style.setProperty("--accent-soft", `color-mix(in srgb, ${c} 12%, white)`);
    }
  }, [embed]);
  const showHeader = !embed || params.get("header") !== "0";
  const newTab = embed ? { target: "_blank", rel: "noopener" } : {};
  const [staffId, setStaffId] = useState<string>("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [details, setDetails] = useState({ name: session?.user.name ?? "", email: session?.user.email ?? "", phone: "", notes: "" });
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const { busy, error: bookError, run } = useAction();

  if (error) return <div className="container"><div className="error">{error}</div></div>;
  if (!biz) return <div className="container muted">Loading…</div>;

  const service = biz.services.find((s: any) => s.id === serviceId);
  const staffForService = biz.staff.filter((s: any) => s.service_ids.includes(serviceId));
  const manageHref = (b: any) => `/manage/${b.manageToken}`;

  const book = () => run(async () => {
    const res = await api(`/public/businesses/${slug}/bookings`, {
      body: {
        serviceId, staffId: slot!.staffId, start: slot!.start, ...details,
        phone: details.phone || undefined, notes: details.notes || undefined, smsOptIn: smsOptIn && !!details.phone,
      },
    });
    if (embed && window.parent !== window) window.parent.postMessage({ type: "slotwise:booked", code: res.booking.code, status: res.booking.status }, "*");
    if (res.paymentUrl && embed) setPendingPayment({ url: res.paymentUrl, booking: res.booking });
    else if (res.paymentUrl) window.location.href = res.paymentUrl;
    else setDone(res.booking);
  });

  if (pendingPayment) {
    const b = pendingPayment.booking;
    return (
      <div className="container narrow">
        <div className="card stack">
          <h1>Almost done: pay to confirm</h1>
          <p>{b.serviceName} with {b.staffName}<br />
            <strong>{DateTime.fromISO(b.start).setZone(biz.timezone).toLocaleString(DateTime.DATETIME_HUGE)}</strong></p>
          <p>We're holding this time for 30 minutes. Payment opens in a new tab.</p>
          <a className="btn primary" href={pendingPayment.url} target="_blank" rel="noopener">Pay now</a>
          <a className="small" href={manageHref(b)} target="_blank" rel="noopener">View or change this booking</a>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="container narrow">
        <div className="card stack">
          <h1>You're booked!</h1>
          <p>{done.serviceName} with {done.staffName}<br />
            <strong>{DateTime.fromISO(done.start).setZone(biz.timezone).toLocaleString(DateTime.DATETIME_HUGE)}</strong></p>
          <p>Booking code: <strong>{done.code}</strong>. A confirmation goes to {done.customerEmail}.</p>
          <AddToCalendar links={done.calendarLinks} />
          {embed
            ? <a href={manageHref(done)} className="btn" {...newTab}>Manage or reschedule</a>
            : <Link to={manageHref(done)} className="btn">Manage or reschedule</Link>}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      {showHeader && (
        <div className="card">
          <h1>{biz.name}</h1>
          <p className="muted">{biz.description}</p>
          <div className="small muted">{[biz.address, biz.phone].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      {embed && biz.aiChat && (
        <div className="card stack">
          <button onClick={() => setChatOpen(!chatOpen)}>{chatOpen ? "Hide chat" : "💬 Prefer to chat? Book with our assistant"}</button>
          {chatOpen && (
            <ChatWidget
              endpoint={`/public/businesses/${slug}/chat`}
              storageKey={`chat:${slug}`}
              greeting={`Hi! I'm ${biz.name}'s booking assistant. What would you like to book? I can also move or cancel an existing appointment.`}
            />
          )}
        </div>
      )}

      {biz.onlineBookingPaused ? (
        <div className="card stack">
          <h2>Online booking is unavailable right now</h2>
          <p>{biz.phone ? <>Please call <a href={`tel:${biz.phone}`}>{biz.phone}</a> to book.</> : "Please contact us directly to book."}</p>
          <p className="small muted">Already booked? Use the link in your confirmation email or text to view or change your booking.</p>
        </div>
      ) : (
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
              <label>Phone {biz.smsEnabled ? "(for text reminders)" : "(optional)"}<input type="tel" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></label>
            </div>
            {biz.smsEnabled && (
              <label className="inline small">
                <input type="checkbox" checked={smsOptIn} disabled={!details.phone} onChange={(e) => setSmsOptIn(e.target.checked)} />
                Text me my confirmation and reminders. I can reply to confirm, reschedule or cancel. Msg &amp; data rates may apply; reply STOP to opt out.
              </label>
            )}
            <label>Notes (optional)<textarea value={details.notes} onChange={(e) => setDetails({ ...details, notes: e.target.value })} /></label>
            <p className="small muted">Free cancellation up to {biz.cancellationHours}h before.</p>
            <button className="primary" disabled={busy}>
              {biz.requirePayment && service.price_cents > 0 ? `Continue to payment (${money(service.deposit_cents || service.price_cents, biz.currency)})` : "Confirm booking"}
            </button>
          </form>
        )}
      </div>
      )}

      {!embed && biz.aiChat && (
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
