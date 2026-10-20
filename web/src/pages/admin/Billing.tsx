import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { UsageMeter } from "../../components/UsageMeter";
import { useBusiness } from "./AdminLayout";

const PACK_LABEL: Record<string, string> = { bookings: "bookings", sms: "text messages", ai: "AI assistant messages" };

/** This month's meters, extra packs, and auto top-up. */
function Usage() {
  const { biz, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/usage`);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const action = useAction();
  if (!data) return null;

  const buy = (packId: string) => action.run(async () => {
    const res = await api(`/admin/${biz.id}/usage/packs`, { body: { packId, packs: counts[packId] ?? 1 } });
    if (res.applied) { reload(); reloadBiz(); } else window.location.href = res.url;
  });

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Usage this month</h2>
        <span className="small muted">Resets {DateTime.fromISO(data.resetsOn).toFormat("LLLL d")}</span>
      </div>
      {action.error && <div className="error">{action.error}</div>}
      <div className="grid">{data.meters.map((m: any) => <UsageMeter key={m.metric} m={m} />)}</div>
      <p className="small muted">
        Every booking counts, whether a customer books online or you add it yourself. We warn you by email and on every
        admin page at 80% and 90%, so you can add more or upgrade before you run out. If an allowance is used up, that feature
        pauses until you add more, upgrade, or it resets.
      </p>

      <h3>Need more?</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Pack</th><th>Price</th><th>How many</th><th /></tr></thead>
          <tbody>
            {data.packs.map((p: any) => (
              <tr key={p.id}>
                <td>{p.quantity} {PACK_LABEL[p.metric]}</td>
                <td>{money(p.priceCents)}</td>
                <td>
                  <select style={{ width: 80 }} value={counts[p.id] ?? 1} onChange={(e) => setCounts({ ...counts, [p.id]: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </td>
                <td><button disabled={action.busy} onClick={() => buy(p.id)}>Buy {money(p.priceCents * (counts[p.id] ?? 1))}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Extra uses you buy are added straight away and last until the end of this month.</p>
      <label className="inline">
        <input type="checkbox" checked={data.autoTopUp} disabled={!data.canAutoTopUp || action.busy}
          onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}/usage/auto-topup`, { method: "PUT", body: { enabled: e.target.checked } }); reload(); reloadBiz(); })} />
        Auto top-up: when something runs out, add the smallest pack automatically and put it on my next invoice
      </label>
      {!data.canAutoTopUp && <span className="small muted">Available on paid plans, because top-ups are added to your monthly plan invoice. On Starter, buy packs as you need them.</span>}
      {data.purchases.length > 0 && (
        <details>
          <summary className="small">Extra uses added this month and before</summary>
          <ul className="small">
            {data.purchases.map((c: any, i: number) => (
              <li key={i}>{DateTime.fromSQL(c.created_at, { zone: "utc" }).toLocal().toFormat("d LLL")}: {c.quantity} {PACK_LABEL[c.metric]} · {c.source === "auto" ? "auto top-up" : c.source === "grant" ? "free credit" : "bought"}{c.price_cents ? ` · ${money(c.price_cents)}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Billing() {
  const { biz, reloadBiz } = useBusiness();
  const { data: plans } = useApi<any[]>(`/admin/${biz.id}/plans`);
  const [params] = useSearchParams();
  const action = useAction();

  const current = plans?.find((p) => p.id === biz.plan);
  const endsOn = biz.plan_ends_at ? DateTime.fromISO(biz.plan_ends_at).toLocaleString(DateTime.DATE_FULL) : null;

  const choose = (planId: string) => action.run(async () => {
    const target = plans?.find((p) => p.id === planId);
    if (target && !target.monthlyPriceCents && current?.monthlyPriceCents && !confirm(
      `Move to ${target.name}? You keep ${current.name} and everything it includes until the end of the month you've already paid for, then move to ${target.name}. You won't be charged again.`,
    )) return;
    const res = await api(`/admin/${biz.id}/billing/checkout`, { body: { planId } });
    if (res.applied) reloadBiz();
    else window.location.href = res.url;
  });

  return (
    <div className="stack">
      {params.get("subscribed") && <div className="notice">Thanks! Your plan will update as soon as payment is confirmed.</div>}
      {params.get("pack") && <div className="notice">Thanks! Your extra uses are added as soon as payment is confirmed.</div>}
      {endsOn && current && (
        <div className="notice row" style={{ justifyContent: "space-between" }}>
          <span>Your {current.name} plan ends on <b>{endsOn}</b>. You keep everything it includes until then, then move to Starter, and you won't be charged again.</span>
          <button disabled={action.busy} onClick={() => action.run(async () => { await api(`/admin/${biz.id}/billing/keep`, { method: "POST" }); reloadBiz(); })}>Keep {current.name}</button>
        </div>
      )}
      <Usage />
      {action.error && <div className="error">{action.error}</div>}
      <div className="grid">
        {plans?.map((p) => (
          <div key={p.id} className="card stack" style={p.id === biz.plan ? { borderColor: "var(--accent)" } : undefined}>
            <h2>{p.name}</h2>
            <div className="stat">{p.monthlyPriceCents ? `${money(p.monthlyPriceCents)}/mo` : "Free"}</div>
            <ul className="small">
              <li>Up to {p.maxStaff} staff</li>
              <li>{p.aiChat ? "AI booking chat + admin assistant" : "No AI chat"}</li>
              <li><b>{p.bookingsPerMonth.toLocaleString()} bookings / month</b></li>
              {p.aiChat && <li>{p.aiMessagesPerMonth.toLocaleString()} AI assistant messages / month</li>}
            </ul>
            {p.id === biz.plan
              ? <span className="badge ok">Current plan ({endsOn ? `ends ${endsOn}` : biz.plan_status})</span>
              : endsOn && !p.monthlyPriceCents ? <span className="badge">Starts {endsOn}</span>
              : <button className="primary" disabled={action.busy} onClick={() => choose(p.id)}>Switch to {p.name}</button>}
          </div>
        ))}
      </div>
      {biz.platform_customer_id && (
        <div><button onClick={() => action.run(async () => { window.location.href = (await api(`/admin/${biz.id}/billing/portal`, { method: "POST" })).url; })}>Manage billing & invoices</button></div>
      )}
    </div>
  );
}
