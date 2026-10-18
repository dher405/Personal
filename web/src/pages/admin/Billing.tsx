import { useSearchParams } from "react-router-dom";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

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
              <li>{p.smsPerMonth.toLocaleString()} text messages / month</li>
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
