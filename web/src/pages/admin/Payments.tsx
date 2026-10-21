import { useState } from "react";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { Copy, Steps, savedHint } from "../../components/Setup";


export function Payments() {
  const { biz, reloadBiz } = useBusiness();
  const { data: payments, reload } = useApi<any[]>(`/admin/${biz.id}/payments`);
  const sum = biz.payment_summary;
  const [provider, setProvider] = useState(biz.payment_provider);
  const [f, setF] = useState<Record<string, string>>({
    locationId: sum.squareLocationId, squareEnv: sum.squareEnv,
    clientId: sum.paypalClientId, paypalEnv: sum.paypalEnv, webhookId: sum.paypalWebhookId,
  });
  const [stripeTax, setStripeTax] = useState(!!sum.stripeTax);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const saved = savedHint;

  const save = () => action.run(async () => {
    setTest(null);
    const body: any = { provider };
    if (provider === "stripe") Object.assign(body, { secretKey: f.stripeKey, webhookSecret: f.stripeWebhook, tax: stripeTax });
    if (provider === "square") Object.assign(body, { accessToken: f.squareToken, locationId: f.locationId, squareEnv: f.squareEnv, webhookKey: f.squareWebhook });
    if (provider === "paypal") Object.assign(body, { clientId: f.clientId, clientSecret: f.clientSecret, paypalEnv: f.paypalEnv, webhookId: f.webhookId });
    await api(`/admin/${biz.id}/payment-provider`, { method: "PUT", body });
    reloadBiz();
    setF({ ...f, stripeKey: "", stripeWebhook: "", squareToken: "", squareWebhook: "", clientSecret: "" });
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
        <p className="muted small">Customers pay into your own Stripe, Square or PayPal account on the provider's secure page. Slotwise never sees card details and takes nothing from your payments; only your provider's own fees apply.</p>
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
            <Steps>
              <li>In <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer">Stripe → Developers → API keys</a>, copy your <b>Secret key</b>. (No Stripe account yet? <a href="https://dashboard.stripe.com/register" target="_blank" rel="noreferrer">Create one</a> and add your bank details first.)</li>
              <li>In <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noreferrer">Stripe → Developers → Webhooks</a>, add an endpoint with the URL below and the event <code>checkout.session.completed</code>, then copy its <b>Signing secret</b>.</li>
            </Steps>
            <label>Your webhook URL<Copy value={sum.webhooks.stripe} /></label>
            <div className="form-grid">
              <label>Secret key<input type="password" autoComplete="off" value={f.stripeKey ?? ""} onChange={set("stripeKey")} placeholder={saved(sum.stripeKey, "sk_live_…")} /></label>
              <label>Webhook signing secret<input type="password" autoComplete="off" value={f.stripeWebhook ?? ""} onChange={set("stripeWebhook")} placeholder={saved(sum.stripeWebhookSecret, "whsec_…")} /></label>
            </div>
            <label className="inline">
              <input type="checkbox" checked={stripeTax} onChange={(e) => setStripeTax(e.target.checked)} />
              Add sales tax at checkout (Stripe Tax)
            </label>
            <p className="small muted" style={{ margin: 0 }}>Stripe works out the tax from the customer's address and adds it on top of your price. Set up Stripe Tax in your own Stripe account first (<a href="https://dashboard.stripe.com/settings/tax" target="_blank" rel="noreferrer">Stripe → Settings → Tax</a>), then click Test connection. Whether your services are taxable depends on where you are; check with your accountant.</p>
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
            <Steps>
              <li>At <a href="https://developer.paypal.com/dashboard/applications" target="_blank" rel="noreferrer">developer.paypal.com → Apps &amp; Credentials</a>, sign in with your PayPal business account, choose <b>Live</b> (or Sandbox to test), create an app, and copy its <b>Client ID</b> and <b>Secret</b>.</li>
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
          </div>
        )}

        <label className="inline">
          <input type="checkbox" checked={!!biz.require_payment} onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}`, { method: "PATCH", body: { require_payment: e.target.checked } }); reloadBiz(); })} />
          Require payment (or deposit) to confirm online bookings
        </label>
        <label className="inline" style={{ opacity: biz.require_payment && provider !== "none" ? 1 : 0.55 }}>
          <input type="checkbox" checked={!!biz.cash_requests} disabled={!biz.require_payment || provider === "none"}
            onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}`, { method: "PATCH", body: { cash_requests: e.target.checked } }); reloadBiz(); })} />
          Let customers ask to pay in person (cash) instead
        </label>
        <p className="small muted" style={{ marginTop: -6 }}>
          They pick "Pay in person" when booking. The time is held, and you get an email (and a text, if you've connected texting) to <b>Accept</b> or <b>Decline</b> it in Bookings.
          It counts toward your plan only once you accept it. Requests you don't answer are released at the appointment time.
        </p>
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
          <thead><tr><th>Date</th><th>Booking</th><th>Provider</th><th>Amount</th><th>Status</th><th /></tr></thead>
          <tbody>
            {payments?.map((p) => (
              <tr key={p.id}>
                <td>{DateTime.fromSQL(p.created_at, { zone: "utc" }).toLocal().toFormat("d LLL yyyy")}</td>
                <td>{p.booking_code} <span className="small muted">{p.customer_name}</span></td>
                <td>{p.provider}</td>
                <td>{money(p.amount_cents, p.currency)}{p.refunded_cents ? <div className="small muted">−{money(p.refunded_cents, p.currency)}</div> : null}</td>
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
