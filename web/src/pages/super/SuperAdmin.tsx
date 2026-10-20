import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AdminLayout } from "../admin/AdminLayout";
import { SuperBusinessPanel } from "./SuperBusinessPanel";
import { PlatformSettings } from "./PlatformSettings";
import { SupportDesk } from "./SupportDesk";
import { DateTime } from "luxon";
import { api, money } from "../../api";
import { useAction, useApi } from "../../hooks";
import { UsageMeter } from "../../components/UsageMeter";

/** One business, exactly as its owner sees it, plus the platform-only "Account & billing" tab. */
function BusinessWorkspace() {
  const { bid } = useParams();
  return (
    <AdminLayout
      embedded
      basePath={`/super/businesses/${bid}`}
      header={<p className="small" style={{ marginTop: 0 }}><Link to="/super/businesses">← All businesses</Link> · You're seeing what this business's admins see. Changes you make here are real and are recorded in the audit log under your name.</p>}
      extraTabs={[{ path: "account", label: "Account & billing ★", element: <SuperBusinessPanel /> }]}
    />
  );
}

export function SuperAdmin() {
  const { data: overview, reload } = useApi<any>("/super/overview");
  const open = overview?.openCases ?? 0;
  // Keep the "Support (n)" count current as you move between cases and tabs.
  const { pathname } = useLocation();
  useEffect(() => { reload(); }, [pathname]);
  return (
    <div className="container">
      <h1>Platform admin</h1>
      <nav className="tabs">
        {[["", "Overview"], ["businesses", "Businesses"], ["support", open ? `Support (${open})` : "Support"], ["users", "Users"], ["plans", "Plans & fees"], ["payments", "Payments"], ["settings", "Settings"], ["audit", "Audit log"]].map(([p, l]) => (
          <NavLink key={p} end={!p} to={p ? `/super/${p}` : "/super"}>{l}</NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="businesses" element={<Businesses />} />
        <Route path="businesses/:bid/*" element={<BusinessWorkspace />} />
        <Route path="users" element={<Users />} />
        <Route path="plans" element={<Plans />} />
        <Route path="payments" element={<AllPayments />} />
        <Route path="settings" element={<PlatformSettings />} />
        <Route path="support/*" element={<SupportDesk />} />
        <Route path="audit" element={<Audit />} />
      </Routes>
    </div>
  );
}

function Overview() {
  const { data } = useApi<any>("/super/overview");
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      {data.storage?.persistent === false && <div className="error"><b>Data isn't being kept.</b> {data.storage.message}</div>}
      {data.storage?.persistent === true && <div className="small muted">✓ {data.storage.message}</div>}
      <div className="grid">
        <Link to="/super/support" className="card" style={{ textDecoration: "none", color: "inherit" }}><div className="muted small">Support cases needing a reply</div><div className="stat">{data.openCases}</div></Link>
        <div className="card"><div className="muted small">Businesses</div><div className="stat">{data.businesses}</div></div>
        <div className="card"><div className="muted small">Users</div><div className="stat">{data.users}</div></div>
        <div className="card"><div className="muted small">Bookings (30d)</div><div className="stat">{data.bookings30d}</div></div>
        <div className="card"><div className="muted small">Customer payments (30d)</div><div className="stat">{money(data.gmv30dCents)}</div></div>
        <div className="card"><div className="muted small">Paying businesses</div><div className="stat">{data.payingBusinesses}</div></div>
        <div className="card"><div className="muted small">Booking packs sold (30d)</div><div className="stat">{money(data.packs30dCents)}</div></div>
        <div className="card"><div className="muted small">Texts sent (30d)</div><div className="stat">{data.sms30d}</div></div>
        <div className="card"><div className="muted small">By plan</div>{data.byPlan.map((p: any) => <div key={p.plan}>{p.plan}: <strong>{p.n}</strong></div>)}</div>
      </div>
    </div>
  );
}

function Businesses() {
  const [q, setQ] = useState("");
  const { data, reload } = useApi<any[]>(`/super/businesses?q=${encodeURIComponent(q)}`);
  const { data: plans } = useApi<any[]>("/super/plans");
  const action = useAction();
  const patch = (id: string, body: object) => action.run(async () => { await api(`/super/businesses/${id}`, { method: "PATCH", body }); reload(); });
  const grant = (b: any) => {
    const metric = prompt(`Give ${b.name} free extra uses this month. Which kind? Type: bookings or ai`, "bookings");
    if (!metric || !["bookings", "ai"].includes(metric)) return;
    const qty = Number(prompt("How many?", "50"));
    if (qty > 0) action.run(async () => { await api(`/super/businesses/${b.id}/credits`, { body: { metric, quantity: qty } }); reload(); });
  };
  const addMember = (id: string) => {
    const email = prompt("Email of the user to add as an admin of this business:");
    if (email) action.run(async () => { await api(`/super/businesses/${id}/members`, { body: { email } }); reload(); });
  };
  return (
    <div className="stack">
      <input placeholder="Search businesses" value={q} onChange={(e) => setQ(e.target.value)} />
      {action.error && <div className="error">{action.error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Business</th><th>Admins</th><th>Plan</th><th>Payments</th><th>Usage this month</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data?.map((b) => (
              <tr key={b.id}>
                <td><Link to={`/super/businesses/${b.id}`}><strong>{b.name}</strong></Link><div className="small muted">/b/{b.slug}</div></td>
                <td className="small">{b.admins}</td>
                <td>
                  <select value={b.plan} onChange={(e) => patch(b.id, { plan: e.target.value })}>
                    {plans?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="small muted">{b.plan_status}</div>
                </td>
                <td>{b.payment_provider}</td>
                <td style={{ minWidth: 200 }}>
                  <div className="stack" style={{ gap: 6 }}>{b.usage.filter((m: any) => m.limit > 0 || m.used > 0).map((m: any) => <UsageMeter key={m.metric} m={m} compact />)}</div>
                </td>
                <td>{b.suspended ? <span className="badge bad">suspended</span> : <span className="badge ok">active</span>}</td>
                <td>
                  <div className="row">
                    <Link className="btn primary" to={`/super/businesses/${b.id}`}>Open</Link>
                    <button onClick={() => addMember(b.id)}>Add admin</button>
                    <button onClick={() => grant(b)}>Give credits</button>
                    <button className={b.suspended ? "" : "danger"} onClick={() => patch(b.id, { suspended: !b.suspended })}>{b.suspended ? "Unsuspend" : "Suspend"}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Users() {
  const [q, setQ] = useState("");
  const { data, reload } = useApi<any[]>(`/super/users?q=${encodeURIComponent(q)}`);
  const action = useAction();
  const patch = (id: string, body: object) => action.run(async () => { await api(`/super/users/${id}`, { method: "PATCH", body }); reload(); });
  const [resetInfo, setResetInfo] = useState<{ email: string; link: string; delivered: boolean } | null>(null);
  const sendReset = (u: any) => action.run(async () => {
    const res = await api(`/super/users/${u.id}/send-reset`, { body: {} });
    setResetInfo({ email: u.email, ...res });
  });
  return (
    <div className="stack">
      {resetInfo && (
        <div className="card stack">
          <strong>{resetInfo.delivered ? `Reset email sent to ${resetInfo.email}.` : `Email isn't set up yet, so nothing was sent to ${resetInfo.email}.`}</strong>
          <span className="small muted">You can also send them this link yourself (by text, for example). It works once and expires in 1 hour:</span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input readOnly value={resetInfo.link} onFocus={(e) => e.target.select()} />
            <button onClick={() => navigator.clipboard?.writeText(resetInfo.link)}>Copy</button>
            <button className="link" onClick={() => setResetInfo(null)}>Dismiss</button>
          </div>
        </div>
      )}
      <input placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
      {action.error && <div className="error">{action.error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Signs in with</th><th>Businesses</th><th>Joined</th><th /></tr></thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="small muted">{u.email}</div></td>
                <td>
                  <select value={u.role} onChange={(e) => confirm(`Make ${u.email} a ${e.target.value}?`) && patch(u.id, { role: e.target.value })}>
                    <option value="customer">customer</option><option value="admin">admin</option><option value="superadmin">superadmin</option>
                  </select>
                </td>
                <td className="small">
                  {[u.has_password ? "Password" : null, ...(u.providers ? u.providers.split(",").map((p: string) => (p === "google" ? "Google" : "Apple")) : [])].filter(Boolean).join(", ")}
                </td>
                <td className="small">{u.businesses}</td>
                <td className="small">{u.created_at.slice(0, 10)}</td>
                <td>
                  <div className="row">
                    <button onClick={() => sendReset(u)}>Send reset link</button>
                    <button onClick={() => { const pw = prompt(`Set a new password for ${u.email} (8+ characters). They'll be signed out everywhere.`); if (pw) patch(u.id, { password: pw }); }}>Set password</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Plans() {
  const { data, setData } = useApi<any[]>("/super/plans");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  if (!data) return <div className="muted">Loading…</div>;
  const update = (i: number, patch: object) => setData(data.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="card stack">
      <p className="muted small">What businesses pay you: a monthly price for a set number of bookings (plus AI assistant messages), billed through your Stripe account. Businesses that need more buy the packs below or upgrade. You take nothing from their customers' payments.</p>
      {action.error && <div className="error">{action.error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Monthly price ($)</th><th>Max staff</th><th>Bookings / mo</th><th>AI chat</th><th>AI messages / mo</th><th /></tr></thead>
          <tbody>
            {data.map((p, i) => (
              <tr key={i}>
                <td><input value={p.id} disabled={p.id === "free"} onChange={(e) => update(i, { id: e.target.value })} /></td>
                <td><input value={p.name} onChange={(e) => update(i, { name: e.target.value })} /></td>
                <td><input type="number" step="0.01" value={p.monthlyPriceCents / 100} onChange={(e) => update(i, { monthlyPriceCents: Math.round(Number(e.target.value) * 100) })} /></td>
                <td><input type="number" value={p.maxStaff} onChange={(e) => update(i, { maxStaff: Number(e.target.value) })} /></td>
                <td><input type="number" min={0} value={p.bookingsPerMonth} onChange={(e) => update(i, { bookingsPerMonth: Number(e.target.value) })} /></td>
                <td><input type="checkbox" checked={p.aiChat} onChange={(e) => update(i, { aiChat: e.target.checked })} /></td>
                <td><input type="number" min={0} value={p.aiMessagesPerMonth} onChange={(e) => update(i, { aiMessagesPerMonth: Number(e.target.value) })} /></td>
                <td>{p.id !== "free" && <button className="danger" onClick={() => setData(data.filter((_, j) => j !== i))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button onClick={() => setData([...data, { id: "new-plan", name: "New plan", monthlyPriceCents: 0, maxStaff: 1, aiChat: false, bookingsPerMonth: 0, aiMessagesPerMonth: 0 }])}>+ Add plan</button>
        <button className="primary" disabled={action.busy} onClick={() => action.run(async () => { setData(await api("/super/plans", { method: "PUT", body: data })); setSaved(true); setTimeout(() => setSaved(false), 2000); })}>Save plans</button>
        {saved && <span className="notice small">Saved</span>}
      </div>
      <p className="small muted">Price changes apply to new subscriptions and plan switches; existing Stripe subscriptions keep their price until changed. Allowance changes apply immediately.</p>
      <Packs />
    </div>
  );
}

const PACK_METRICS: Record<string, string> = { bookings: "Bookings", ai: "AI assistant messages" };

/** Top-up packs businesses can buy when they run low. */
function Packs() {
  const { data, setData } = useApi<any[]>("/super/packs");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  if (!data) return null;
  const update = (i: number, patch: object) => setData(data.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <h2>Top-up packs</h2>
      <p className="small muted">What businesses can buy when they run low. The smallest pack of each kind is the one auto top-up adds.</p>
      {action.error && <div className="error">{action.error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Adds</th><th>Quantity</th><th>Price ($)</th><th /></tr></thead>
          <tbody>
            {data.map((p, i) => (
              <tr key={i}>
                <td><input value={p.id} onChange={(e) => update(i, { id: e.target.value })} /></td>
                <td>
                  <select value={p.metric} onChange={(e) => update(i, { metric: e.target.value })}>
                    {Object.entries(PACK_METRICS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </td>
                <td><input type="number" min={1} value={p.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) })} /></td>
                <td><input type="number" step="0.01" min={0} value={p.priceCents / 100} onChange={(e) => update(i, { priceCents: Math.round(Number(e.target.value) * 100) })} /></td>
                <td><button className="danger" onClick={() => setData(data.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button onClick={() => setData([...data, { id: `pack-${data.length + 1}`, metric: "bookings", quantity: 50, priceCents: 1000 }])}>+ Add pack</button>
        <button className="primary" disabled={action.busy} onClick={() => action.run(async () => { setData(await api("/super/packs", { method: "PUT", body: data })); setSaved(true); setTimeout(() => setSaved(false), 2000); })}>Save packs</button>
        {saved && <span className="notice small">Saved</span>}
      </div>
    </div>
  );
}

function AllPayments() {
  const { data, reload } = useApi<any[]>("/super/payments");
  const action = useAction();
  const refund = (p: any) => {
    const input = prompt(`Refund how much? Blank = full remaining ${money(p.amount_cents - p.refunded_cents, p.currency)}`, "");
    if (input === null) return;
    action.run(async () => {
      await api(`/admin/${p.business_id}/payments/${p.id}/refund`, { body: { amountCents: input ? Math.round(parseFloat(input) * 100) : undefined, reason: "Platform refund" } });
      reload();
    });
  };
  return (
    <div className="card table-wrap">
      {action.error && <div className="error">{action.error}</div>}
      <table>
        <thead><tr><th>Date</th><th>Business</th><th>Booking</th><th>Provider</th><th>Amount</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td className="small">{DateTime.fromSQL(p.created_at, { zone: "utc" }).toLocal().toFormat("d LLL yyyy")}</td>
              <td>{p.business_name}</td><td>{p.booking_code}</td><td>{p.provider}</td>
              <td>{money(p.amount_cents, p.currency)}{p.refunded_cents ? <div className="small muted">−{money(p.refunded_cents, p.currency)}</div> : null}</td>
              <td><span className="badge">{p.status}</span></td>
              <td>{["paid", "partially_refunded"].includes(p.status) && <button className="danger" onClick={() => refund(p)}>Refund</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit() {
  const { data } = useApi<any[]>("/super/audit");
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          {data?.map((a) => (
            <tr key={a.id}><td className="small">{a.created_at}</td><td className="small">{a.actor_label}</td><td>{a.action}</td><td className="small muted" style={{ maxWidth: 420, wordBreak: "break-word" }}>{a.details}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
