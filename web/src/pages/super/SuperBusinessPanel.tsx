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
              {plans?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.monthlyPriceCents ? `${money(p.monthlyPriceCents)}/mo` : "free"})</option>)}
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
            const metric = prompt("Give free extra uses this month. Which kind? bookings, sms or ai", "bookings");
            if (!metric || !["bookings", "sms", "ai"].includes(metric)) return;
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
        <p className="small muted">A suspended business is hidden from customers: its booking page and website calendar stop working. Its data is kept.</p>
        <div>
          <button className={b.suspended ? "primary" : "danger"} onClick={() => confirm(b.suspended ? "Reactivate this business?" : "Suspend this business? Customers won't be able to book.") && patch({ suspended: !b.suspended })}>
            {b.suspended ? "Reactivate business" : "Suspend business"}
          </button>
        </div>
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
