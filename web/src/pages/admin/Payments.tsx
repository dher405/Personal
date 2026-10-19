import { useState } from "react";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input readOnly value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }} />
      <button type="button" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

const Steps = ({ children }: { children: React.ReactNode }) => <ol className="small muted" style={{ margin: 0, paddingLeft: 20 }}>{children}</ol>;

export function Payments() {
  const { biz, reloadBiz } = useBusiness();
  const { data: payments, reload } = useApi<any[]>(`/admin/${biz.id}/payments`);
  const sum = biz.payment_summary;
  const [provider, setProvider] = useState(biz.payment_provider);
  const [stripeMode, setStripeMode] = useState(sum.platform.stripe ? sum.stripeMode : "keys");
  const [paypalMode, setPaypalMode] = useState(sum.platform.paypal ? sum.paypalMode : "own");
  const [f, setF] = useState<Record<string, string>>({
    locationId: sum.squareLocationId, squareEnv: sum.squareEnv, merchantId: sum.paypalMerchantId,
    clientId: sum.paypalClientId, paypalEnv: sum.paypalEnv, webhookId: sum.paypalWebhookId,
  });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  // Saved secrets are never sent back; the box shows the last 4 characters, and leaving it blank keeps the saved value.
  const saved = (preview: string, placeholder: string) => (preview ? `${preview} saved` : placeholder);

  const save = () => action.run(async () => {
    setTest(null);
    const body: any = { provider };
    if (provider === "stripe") Object.assign(body, { mode: stripeMode, secretKey: f.stripeKey, webhookSecret: f.stripeWebhook });
    if (provider === "square") Object.assign(body, { accessToken: f.squareToken, locationId: f.locationId, squareEnv: f.squareEnv, webhookKey: f.squareWebhook });
    if (provider === "paypal") Object.assign(body, paypalMode === "own"
      ? { mode: "own", clientId: f.clientId, clientSecret: f.clientSecret, paypalEnv: f.paypalEnv, webhookId: f.webhookId }
      : { mode: "platform", merchantId: f.merchantId });
    const res = await api(`/admin/${biz.id}/payment-provider`, { method: "PUT", body });
    if (res.onboardingUrl) window.location.href = res.onboardingUrl;
    else { reloadBiz(); setF({ ...f, stripeKey: "", stripeWebhook: "", squareToken: "", squareWebhook: "", clientSecret: "" }); }
  });

  const refund = (p: any) => action.run(async () => {
    const input = prompt(`Refund how much? Leave blank for the full ${money(p.amount_cents - p.refunded_cents, p.currency)}`, "");
    if (input === null) return;
    await api(`/admin/${biz.id}/payments/${p.id}/refund`, { body: { amountCents: input ? Math.round(parseFloat(input) * 100) : undefined, reason: "Admin refund" } });
    reload();
  });

  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2>How customers pay you</h2>
        <p className="muted small">Payments go straight to your own account; customers pay on the provider's secure page. Platform fee on your plan: {(biz.plan_details.platformFeeBps / 100).toFixed(2)}% (collected only through Stripe Connect or PayPal by merchant ID).</p>
        {action.error && <div className="error">{action.error}</div>}
        <label>Provider
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setTest(null); }}>
            <option value="none">No online payments (pay in person)</option>
            <option value="stripe">Stripe {biz.payment_provider === "stripe" ? "(current)" : ""}</option>
            <option value="square">Square {biz.payment_provider === "square" ? "(current)" : ""}</option>
            <option value="paypal">PayPal {biz.payment_provider === "paypal" ? "(current)" : ""}</option>
            <option value="mock">Test mode (no real money)</option>
          </select>
        </label>

        {provider === "stripe" && (
          <div className="stack">
            <div className="row">
              {sum.platform.stripe && <label className="inline"><input type="radio" checked={stripeMode === "connect"} onChange={() => setStripeMode("connect")} /> Connect with Stripe (easiest)</label>}
              <label className="inline"><input type="radio" checked={stripeMode === "keys"} onChange={() => setStripeMode("keys")} /> Use my own Stripe API keys</label>
            </div>
            {stripeMode === "connect" ? (
              <p className="small muted">{sum.stripeConnected ? "Your Stripe account is connected. Save to finish or update your Stripe details." : "When you save, Stripe opens so you can create or sign in to your account and add your bank details. Nothing else to copy."}</p>
            ) : (
              <>
                <Steps>
                  <li>In <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer">Stripe → Developers → API keys</a>, copy your <b>Secret key</b>.</li>
                  <li>In <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noreferrer">Stripe → Developers → Webhooks</a>, add an endpoint with the URL below and the event <code>checkout.session.completed</code>, then copy its <b>Signing secret</b>.</li>
                </Steps>
                <label>Your webhook URL<Copy value={sum.webhooks.stripe} /></label>
                <div className="form-grid">
                  <label>Secret key<input type="password" autoComplete="off" value={f.stripeKey ?? ""} onChange={set("stripeKey")} placeholder={saved(sum.stripeKey, "sk_live_…")} /></label>
                  <label>Webhook signing secret<input type="password" autoComplete="off" value={f.stripeWebhook ?? ""} onChange={set("stripeWebhook")} placeholder={saved(sum.stripeWebhookSecret, "whsec_…")} /></label>
                </div>
              </>
            )}
          </div>
        )}

        {provider === "square" && (
          <div className="stack">
            <Steps>
              <li>In the <a href="https://developer.squareup.com/apps" target="_blank" rel="noreferrer">Square Developer dashboard</a>, open (or create) an app and copy its <b>Access token</b> (Credentials).</li>
              <li>Under <b>Locations</b>, copy the <b>Location ID</b> for the place you take payments.</li>
              <li>Optional but recommended: under <b>Webhooks → Subscriptions</b>, add the URL below with the event <code>payment.updated</code> and copy its <b>Signature key</b>.</li>
            </Steps>
            <label>Your webhook URL<Copy value={sum.webhooks.square} /></label>
            <div className="form-grid">
              <label>Access token<input type="password" autoComplete="off" value={f.squareToken ?? ""} onChange={set("squareToken")} placeholder={saved(sum.squareToken, "EAAA…")} /></label>
              <label>Location ID<input value={f.locationId ?? ""} onChange={set("locationId")} /></label>
              <label>Environment
                <select value={f.squareEnv} onChange={set("squareEnv")}><option value="production">Production (real payments)</option><option value="sandbox">Sandbox (testing)</option></select>
              </label>
              <label>Webhook signature key<input type="password" autoComplete="off" value={f.squareWebhook ?? ""} onChange={set("squareWebhook")} placeholder={saved(sum.squareWebhookKey, "optional")} /></label>
            </div>
          </div>
        )}

        {provider === "paypal" && (
          <div className="stack">
            <div className="row">
              {sum.platform.paypal && <label className="inline"><input type="radio" checked={paypalMode === "platform"} onChange={() => setPaypalMode("platform")} /> Just my merchant ID (easiest)</label>}
              <label className="inline"><input type="radio" checked={paypalMode === "own"} onChange={() => setPaypalMode("own")} /> Use my own PayPal app</label>
            </div>
            {paypalMode === "platform" ? (
              <>
                <Steps><li>In PayPal, open <b>Account settings → Business information</b> and copy your <b>PayPal Merchant ID</b>.</li></Steps>
                <label>PayPal merchant ID<input value={f.merchantId ?? ""} onChange={set("merchantId")} /></label>
              </>
            ) : (
              <>
                <Steps>
                  <li>At <a href="https://developer.paypal.com/dashboard/applications" target="_blank" rel="noreferrer">developer.paypal.com → Apps &amp; Credentials</a>, choose <b>Live</b> (or Sandbox to test), create an app, and copy its <b>Client ID</b> and <b>Secret</b>.</li>
                  <li>Optional but recommended: in that app, add a webhook with the URL below and the events <code>CHECKOUT.ORDER.APPROVED</code> and <code>PAYMENT.CAPTURE.COMPLETED</code>, then copy its <b>Webhook ID</b>.</li>
                </Steps>
                <label>Your webhook URL<Copy value={sum.webhooks.paypal} /></label>
                <div className="form-grid">
                  <label>Client ID<input value={f.clientId ?? ""} onChange={set("clientId")} /></label>
                  <label>Secret<input type="password" autoComplete="off" value={f.clientSecret ?? ""} onChange={set("clientSecret")} placeholder={saved(sum.paypalClientSecret, "")} /></label>
                  <label>Environment
                    <select value={f.paypalEnv} onChange={set("paypalEnv")}><option value="live">Live (real payments)</option><option value="sandbox">Sandbox (testing)</option></select>
                  </label>
                  <label>Webhook ID<input value={f.webhookId ?? ""} onChange={set("webhookId")} placeholder="optional" /></label>
                </div>
              </>
            )}
          </div>
        )}

        {(provider === "stripe" && stripeMode === "keys") || (provider === "paypal" && paypalMode === "own") ? (
          <p className="small muted">With your own keys, payments go straight to your account and no per-payment platform fee is taken. Slotwise never sees card details.</p>
        ) : null}

        <label className="inline">
          <input type="checkbox" checked={!!biz.require_payment} onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}`, { method: "PATCH", body: { require_payment: e.target.checked } }); reloadBiz(); })} />
          Require payment (or deposit) to confirm online bookings
        </label>
        {test && <div className={test.ok ? "notice" : "error"}>{test.message}</div>}
        <div className="row">
          <button className="primary" disabled={action.busy}>Save payment settings</button>
          <button type="button" disabled={action.busy || provider !== biz.payment_provider} title={provider !== biz.payment_provider ? "Save first" : ""}
            onClick={() => action.run(async () => setTest(await api(`/admin/${biz.id}/payment-provider/test`, { method: "POST" })))}>Test connection</button>
        </div>
        <p className="small muted">Webhooks are a backup: payments are also confirmed when the customer returns from the payment page.</p>
      </form>
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
