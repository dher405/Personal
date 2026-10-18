import { useState } from "react";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

export function Payments() {
  const { biz, reloadBiz } = useBusiness();
  const { data: payments, reload } = useApi<any[]>(`/admin/${biz.id}/payments`);
  const [provider, setProvider] = useState(biz.payment_provider);
  const [square, setSquare] = useState({ accessToken: "", locationId: biz.payment_summary.squareLocationId ?? "" });
  const [merchantId, setMerchantId] = useState(biz.payment_summary.paypalMerchantId ?? "");
  const action = useAction();

  const save = () => action.run(async () => {
    const body: any = { provider };
    if (provider === "square") Object.assign(body, square);
    if (provider === "paypal") body.merchantId = merchantId;
    const res = await api(`/admin/${biz.id}/payment-provider`, { method: "PUT", body });
    if (res.onboardingUrl) window.location.href = res.onboardingUrl;
    else reloadBiz();
  });

  const refund = (p: any) => action.run(async () => {
    const input = prompt(`Refund how much? Leave blank for the full ${money(p.amount_cents - p.refunded_cents, p.currency)}`, "");
    if (input === null) return;
    await api(`/admin/${biz.id}/payments/${p.id}/refund`, { body: { amountCents: input ? Math.round(parseFloat(input) * 100) : undefined, reason: "Admin refund" } });
    reload();
  });

  return (
    <div className="stack">
      <div className="card stack">
        <h2>How customers pay you</h2>
        <p className="muted small">Payments go straight to your own account. Platform fee on your plan: {(biz.plan_details.platformFeeBps / 100).toFixed(2)}%.</p>
        {action.error && <div className="error">{action.error}</div>}
        <label>Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="none">No online payments (pay in person)</option>
            <option value="stripe">Stripe {biz.payment_summary.stripeConnected ? "(connected)" : ""}</option>
            <option value="square">Square</option>
            <option value="paypal">PayPal</option>
            <option value="mock">Test mode (no real money)</option>
          </select>
        </label>
        {provider === "stripe" && <p className="small muted">You'll be sent to Stripe to create or finish connecting your account.</p>}
        {provider === "square" && (
          <div className="form-grid">
            <label>Square access token<input type="password" placeholder={biz.payment_summary.squareConfigured ? "•••••• (saved)" : ""} value={square.accessToken} onChange={(e) => setSquare({ ...square, accessToken: e.target.value })} /></label>
            <label>Location ID<input value={square.locationId} onChange={(e) => setSquare({ ...square, locationId: e.target.value })} /></label>
          </div>
        )}
        {provider === "paypal" && <label>PayPal merchant ID<input value={merchantId} onChange={(e) => setMerchantId(e.target.value)} /></label>}
        <label className="inline">
          <input type="checkbox" checked={!!biz.require_payment} onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}`, { method: "PATCH", body: { require_payment: e.target.checked } }); reloadBiz(); })} />
          Require payment (or deposit) to confirm online bookings
        </label>
        <div><button className="primary" disabled={action.busy} onClick={save}>Save payment settings</button></div>
      </div>
      <div className="card table-wrap">
        <h2>Payments</h2>
        <table>
          <thead><tr><th>Date</th><th>Booking</th><th>Provider</th><th>Amount</th><th>Fee</th><th>Status</th><th /></tr></thead>
          <tbody>
            {payments?.map((p) => (
              <tr key={p.id}>
                <td>{DateTime.fromSQL(p.created_at, { zone: "utc" }).toLocal().toFormat("d LLL yyyy")}</td>
                <td>{p.booking_code} <span className="small muted">{p.customer_name}</span></td>
                <td>{p.provider}</td>
                <td>{money(p.amount_cents, p.currency)}{p.refunded_cents ? <div className="small muted">−{money(p.refunded_cents, p.currency)}</div> : null}</td>
                <td className="small">{money(p.platform_fee_cents, p.currency)}</td>
                <td><span className="badge">{p.status.replace("_", " ")}</span></td>
                <td>{["paid", "partially_refunded"].includes(p.status) && <button className="danger" onClick={() => refund(p)}>Refund</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {payments?.length === 0 && <p className="muted">No payments yet.</p>}
      </div>
    </div>
  );
}
