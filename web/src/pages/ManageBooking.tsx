import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money } from "../api";
import { useAction, useApi } from "../hooks";
import { SlotPicker, type Slot } from "../components/SlotPicker";
import { AddToCalendar } from "../components/AddToCalendar";

const statusBadge: Record<string, string> = { confirmed: "ok", pending_payment: "warn", requested: "warn", cancelled: "bad", completed: "", no_show: "bad" };

export function ManageBooking() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const { data, reload, error } = useApi<any>(`/public/manage/${token}`);
  const [moving, setMoving] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const action = useAction();

  // Back from a hosted checkout: settle with the provider now rather than waiting for the webhook.
  useEffect(() => {
    if (params.get("paid") === "1") api(`/payments/sync/${token}`, { method: "POST" }).finally(reload);
  }, []);

  if (error) return <div className="container"><div className="error">{error}</div></div>;
  if (!data) return <div className="container muted">Loading…</div>;
  const { booking: b, business: biz } = data;
  const when = DateTime.fromISO(b.start).setZone(biz.timezone);
  const active = ["confirmed", "pending_payment"].includes(b.status);

  return (
    <div className="container narrow">
      <div className="card stack">
        <div className="row"><h1 style={{ margin: 0 }}>{biz.name}</h1><span className={`badge ${statusBadge[b.status]}`}>{b.status === "requested" ? "waiting for approval" : b.status.replace("_", " ")}</span></div>
        <p>{b.serviceName} with {b.staffName}<br /><strong>{when.toLocaleString(DateTime.DATETIME_HUGE)}</strong></p>
        <p className="small muted">Booking code {b.code} · {money(b.priceCents, b.currency)}</p>
        {b.payments.map((p: any) => (
          <div key={p.id} className="small">Payment {money(p.amount_cents, b.currency)} — {p.status.replace("_", " ")}{p.refunded_cents ? ` (refunded ${money(p.refunded_cents, b.currency)})` : ""}</div>
        ))}
        {action.error && <div className="error">{action.error}</div>}
        {b.status === "requested" && (
          <div className="notice">
            You've asked to pay in person. The time is held for you, and {biz.name} will accept or decline your request; you'll get an email either way.
          </div>
        )}
        {b.status === "requested" && (
          <div><button className="danger" disabled={action.busy} onClick={() => confirm("Cancel your request?") && action.run(async () => { await api(`/public/manage/${token}/cancel`, { method: "POST", body: {} }); reload(); })}>
            Cancel request
          </button></div>
        )}
        {b.status === "cancelled" && b.declineReason !== null && b.payInPerson && (
          <p>{biz.name} couldn't accept this request{b.declineReason ? `: ${b.declineReason}` : "."} <a href={`/b/${biz.slug}`}>Book another time</a></p>
        )}
        {b.payInPerson && b.status === "confirmed" && <p className="small">💵 You're paying in person at your appointment.</p>}
        {b.status === "pending_payment" && (
          <button className="primary" disabled={action.busy} onClick={() => action.run(async () => { window.location.href = (await api(`/public/manage/${token}/pay`, { method: "POST" })).paymentUrl; })}>
            Complete payment
          </button>
        )}
        {b.meetingMode === "online" && ["confirmed", "completed"].includes(b.status) && (b.meetingUrl
          ? <a className="btn primary" href={b.meetingUrl} target="_blank" rel="noreferrer">💻 Join the online meeting</a>
          : <p className="small">💻 This is an online session. {biz.name} will send you the meeting link before it starts.</p>)}
        {b.meetingMode !== "online" && b.status === "confirmed" && biz.address && <p className="small">📍 {biz.address}</p>}
        {b.status === "confirmed" && <AddToCalendar links={b.calendarLinks} />}
        {active && (b.customerConfirmedAt ? <span className="badge ok">You confirmed you'll be there</span> : (
          <button className="primary" disabled={action.busy} onClick={() => action.run(async () => { await api(`/public/manage/${token}/confirm`, { method: "POST", body: {} }); reload(); })}>
            ✓ I'll be there
          </button>
        ))}
        {active && (
          <div className="row">
            <button onClick={() => setMoving(!moving)}>Reschedule</button>
            <button className="danger" disabled={action.busy} onClick={() => confirm("Cancel this booking?") && action.run(async () => { await api(`/public/manage/${token}/cancel`, { method: "POST", body: {} }); reload(); })}>
              Cancel booking
            </button>
          </div>
        )}
        <p className="small muted">Changes online are allowed up to {biz.cancellation_hours}h before your appointment{biz.phone ? `; after that call ${biz.phone}` : ""}.</p>
      </div>
      {moving && (
        <div className="card stack">
          <h2>Pick a new time</h2>
          <SlotPicker timezone={biz.timezone} selected={slot} onPick={setSlot} initialDay={when.toISODate()!}
            slotsPath={(day) => `/public/businesses/${biz.slug}/slots?serviceId=${b.serviceId}&from=${day}&staffId=${b.staffId}`} />
          <button className="primary" disabled={!slot || action.busy} onClick={() => action.run(async () => {
            await api(`/public/manage/${token}/reschedule`, { body: { start: slot!.start } });
            setMoving(false); setSlot(null); reload();
          })}>Move to {slot ? DateTime.fromISO(slot.start).setZone(biz.timezone).toFormat("ccc d LLL, h:mm a") : "…"}</button>
        </div>
      )}
    </div>
  );
}
