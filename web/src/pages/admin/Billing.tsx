import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { UsageMeter } from "../../components/UsageMeter";
import { useBusiness } from "./AdminLayout";

const PACK_LABEL: Record<string, string> = { bookings: "online bookings", sms: "text messages", ai: "AI assistant messages" };

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
        Bookings you add yourself in Bookings are free and never counted. We email you at 80% and 100% of each allowance.
        When an allowance is used up, that feature pauses until you add more, upgrade, or it resets.
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
      {!data.canAutoTopUp && <span className="small muted">Available once you have a card on file (subscribe to a paid plan or buy a pack once).</span>}
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

  const choose = (planId: string) => action.run(async () => {
    const res = await api(`/admin/${biz.id}/billing/checkout`, { body: { planId } });
    if (res.applied) reloadBiz();
    else window.location.href = res.url;
  });

  return (
    <div className="stack">
      {params.get("subscribed") && <div className="notice">Thanks! Your plan will update as soon as payment is confirmed.</div>}
      {params.get("pack") && <div className="notice">Thanks! Your extra uses are added as soon as payment is confirmed.</div>}
      <Usage />
      {action.error && <div className="error">{action.error}</div>}
      <div className="grid">
        {plans?.map((p) => (
          <div key={p.id} className="card stack" style={p.id === biz.plan ? { borderColor: "var(--accent)" } : undefined}>
            <h2>{p.name}</h2>
            <div className="stat">{p.monthlyPriceCents ? `${money(p.monthlyPriceCents)}/mo` : "Free"}</div>
            <ul className="small">
              <li>Up to {p.maxStaff} staff</li>
              <li>{(p.platformFeeBps / 100).toFixed(2)}% fee on online payments</li>
              <li>{p.aiChat ? "AI booking chat + admin assistant" : "No AI chat"}</li>
              <li>{p.bookingsPerMonth.toLocaleString()} online bookings / month</li>
              <li>{p.smsPerMonth.toLocaleString()} text messages / month</li>
              {p.aiChat && <li>{p.aiMessagesPerMonth.toLocaleString()} AI assistant messages / month</li>}
            </ul>
            {p.id === biz.plan ? <span className="badge ok">Current plan ({biz.plan_status})</span> : <button className="primary" disabled={action.busy} onClick={() => choose(p.id)}>Switch to {p.name}</button>}
          </div>
        ))}
      </div>
      {biz.platform_customer_id && (
        <div><button onClick={() => action.run(async () => { window.location.href = (await api(`/admin/${biz.id}/billing/portal`, { method: "POST" })).url; })}>Manage billing & invoices</button></div>
      )}
    </div>
  );
}
