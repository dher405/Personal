import { useState } from "react";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "../admin/AdminLayout";
import { UsageMeter } from "../../components/UsageMeter";

const stripeUrl = (mode: string, path: string) => `https://dashboard.stripe.com/${mode === "test" ? "test/" : ""}${path}`;
const PACK_LABEL: Record<string, string> = { bookings: "bookings", sms: "texts", ai: "AI messages" };

/** Platform-only controls for one business: plan, billing, admins, usage credits, suspension, activity. */
export function SuperBusinessPanel() {
  const { biz, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/super/businesses/${biz.id}`);
  const { data: plans } = useApi<any[]>("/super/plans");
  const action = useAction();
  if (!data) return <div className="muted">Loading…</div>;
  const b = data.business;
  const refresh = () => { reload(); reloadBiz(); };
  const [result, setResult] = useState("");
  const patch = (body: object) => action.run(async () => { await api(`/super/businesses/${b.id}`, { method: "PATCH", body }); refresh(); });

  return (
    <div className="stack">
      {action.error && <div className="error">{action.error}</div>}
      <div className="grid">
        <div className="card"><div className="muted small">Their plan</div><div className="stat">{data.revenue.planMonthlyCents ? `${money(data.revenue.planMonthlyCents)}/mo` : "Free"}</div></div>
        <div className="card"><div className="muted small">Packs bought this month</div><div className="stat">{money(data.revenue.packsThisMonthCents)}</div><div className="small muted">{money(data.revenue.packsAllTimeCents)} all time</div></div>
        <div className="card"><div className="muted small">Their customers paid them this month</div><div className="stat">{money(data.revenue.customerPaymentsThisMonthCents)}</div></div>
        <div className="card"><div className="muted small">Bookings this month</div><div className="stat">{data.stats.bookingsThisMonth}</div><div className="small muted">{data.stats.bookingsAllTime} all time · {data.stats.staff} staff</div></div>
      </div>

      <div className="card stack">
        <h2>Plan and billing</h2>
        <div className="row">
          <label>Plan
            <select value={b.plan} onChange={(e) => confirm("Change this business's plan directly? This doesn't charge or refund their card; use it for comped or special accounts.") && patch({ plan: e.target.value })}>
              {plans?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.monthlyPriceCents ? `${money(p.monthlyPriceCents)}/mo` : "free"}){p.visible === false ? " · hidden plan" : ""}</option>)}
            </select>
          </label>
          <span className="badge">{b.plan_status}</span>
          {b.plan_ends_at && <span className="badge">moves to Starter {new Date(b.plan_ends_at).toLocaleDateString()}</span>}
          {b.auto_topup && <span className="badge ok">auto top-up on</span>}
        </div>
        {data.stripeMode === "off" ? (
          <p className="small muted">Stripe isn't connected to the platform yet, so plans and packs are applied without charging. Add your Stripe keys in Render to bill for real.</p>
        ) : (
          <div className="small stack" style={{ gap: 4 }}>
            <span>Stripe ({data.stripeMode} mode): {b.platform_customer_id
              ? <a href={stripeUrl(data.stripeMode, `customers/${b.platform_customer_id}`)} target="_blank" rel="noreferrer">customer, cards and invoices ↗</a>
              : "no card on file yet (they haven't subscribed or bought a pack)"}</span>
            {b.platform_subscription_id && <a href={stripeUrl(data.stripeMode, `subscriptions/${b.platform_subscription_id}`)} target="_blank" rel="noreferrer">Subscription ↗</a>}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Usage this month</h2>
          <button onClick={() => {
            const metric = prompt("Give free extra uses this month. Which kind? bookings or ai", "bookings");
            if (!metric || !["bookings", "ai"].includes(metric)) return;
            const qty = Number(prompt("How many?", "50"));
            if (qty > 0) action.run(async () => { await api(`/super/businesses/${b.id}/credits`, { body: { metric, quantity: qty } }); refresh(); });
          }}>Give credits</button>
        </div>
        <div className="grid">{data.usage.map((m: any) => <UsageMeter key={m.metric} m={m} />)}</div>
        {data.credits.length > 0 && (
          <details>
            <summary className="small">Extra uses added ({data.credits.length})</summary>
            <ul className="small">
              {data.credits.map((c: any) => (
                <li key={c.id}>{c.created_at.slice(0, 10)}: {c.quantity} {PACK_LABEL[c.metric]} · {c.source}{c.price_cents ? ` · ${money(c.price_cents)} (${c.charge_status})` : ""}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Admins of this business</h2>
          <button onClick={() => {
            const email = prompt("Email of the person to make an admin (they must have signed up already):");
            if (email) action.run(async () => { await api(`/super/businesses/${b.id}/members`, { body: { email, role: "manager" } }); refresh(); });
          }}>Add admin</button>
        </div>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Signs in with</th><th /></tr></thead>
          <tbody>
            {data.admins.map((a: any) => (
              <tr key={a.id}>
                <td>{a.name}<div className="small muted">{a.email}</div></td>
                <td>{a.role}</td>
                <td className="small">{["Password", ...(a.providers ? a.providers.split(",").map((p: string) => (p === "google" ? "Google" : "Apple")) : [])].join(", ")}</td>
                <td>
                  <div className="row">
                    <button onClick={() => action.run(async () => { const r = await api(`/super/users/${a.id}/send-reset`, { body: {} }); prompt(r.delivered ? "Reset email sent. The link, if you need it:" : "Email isn't set up, so send them this link yourself:", r.link); })}>Reset link</button>
                    <button className="danger" onClick={() => confirm(`Remove ${a.email} as an admin of ${b.name}?`) && action.run(async () => { await api(`/super/businesses/${b.id}/members/${a.id}`, { method: "DELETE" }); refresh(); })}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card stack">
        <h2>Status</h2>
        {result && <div className="notice small">{result}</div>}
        {b.closed_at ? (
          <>
            <p className="small"><b>Closed</b> on {new Date(b.closed_at).toLocaleDateString()}. Its billing was cancelled and its upcoming bookings were cancelled and refunded. Its records are kept until you delete it.</p>
            <div>
              <button className="danger" disabled={action.busy} onClick={() => {
                const typed = prompt(`Delete ${b.name} permanently? Every booking, customer record, payment record and setting it has is erased, and this can't be undone. Type the business name to confirm:`);
                if (typed === null) return;
                if (typed.trim() !== b.name) { alert("The name didn't match, so nothing was deleted."); return; }
                action.run(async () => { await api(`/super/businesses/${b.id}`, { method: "DELETE" }); window.location.href = "/super/businesses"; });
              }}>Delete permanently</button>
            </div>
          </>
        ) : (
          <>
            <p className="small muted">
              <b>Suspend</b> hides the business from customers (its booking page and website calendar stop working) and pauses its Slotwise subscription, so it isn't charged while suspended. Reactivating resumes both. Existing bookings are left as they are.
            </p>
            <p className="small muted">
              <b>Close</b> is for a business that's leaving: its subscription is cancelled now (no more charges), every upcoming booking is cancelled with the customer emailed and refunded in full, and the business is hidden. After closing you can delete it permanently.
            </p>
            <div className="row">
              <button className={b.suspended ? "primary" : "danger"} disabled={action.busy} onClick={() => confirm(b.suspended ? "Reactivate this business? Its subscription resumes billing." : "Suspend this business? Customers won't be able to book, and its subscription is paused (no charges) until you reactivate it.") && patch({ suspended: !b.suspended })}>
                {b.suspended ? "Reactivate business" : "Suspend business"}
              </button>
              <button className="danger" disabled={action.busy} onClick={() => confirm(`Close ${b.name}? This cancels its Slotwise subscription now, cancels every upcoming booking and refunds those customers in full (they're emailed), and hides the business. It can't be reopened.`) && action.run(async () => {
                const r = await api(`/super/businesses/${b.id}/close`, { method: "POST" });
                setResult(`Closed. ${r.subscriptionCancelled ? "Subscription cancelled in Stripe. " : ""}${r.bookingsCancelled} upcoming booking${r.bookingsCancelled === 1 ? "" : "s"} cancelled.${r.refundsFailed ? ` ${r.refundsFailed} refund${r.refundsFailed === 1 ? "" : "s"} failed: see the Bookings tab.` : ""}`);
                refresh();
              })}>Close business</button>
            </div>
          </>
        )}
      </div>

      <div className="card table-wrap">
        <h2>Recent activity</h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>
            {data.audit.map((a: any) => (
              <tr key={a.id}>
                <td className="small">{DateTime.fromSQL(a.created_at, { zone: "utc" }).toLocal().toFormat("d LLL, h:mm a")}</td>
                <td className="small">{a.actor_label}</td>
                <td className="small">{a.action.replace(/[._]/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.audit.length === 0 && <p className="muted small">No activity recorded yet.</p>}
      </div>
    </div>
  );
}
