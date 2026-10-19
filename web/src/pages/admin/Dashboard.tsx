import { Link } from "react-router-dom";
import { DateTime } from "luxon";
import { money } from "../../api";
import { useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { UsageMeter } from "../../components/UsageMeter";

export function Dashboard() {
  const { biz, base } = useBusiness();
  const { data: stats } = useApi<any>(`/admin/${biz.id}/stats`);
  const { data: services } = useApi<any[]>(`/admin/${biz.id}/services`);
  const { data: staff } = useApi<any[]>(`/admin/${biz.id}/staff`);
  const today = DateTime.now().setZone(biz.timezone).toISODate();
  const { data: todays } = useApi<any[]>(`/admin/${biz.id}/bookings?from=${today}&to=${today}`);

  const checklist = [
    { done: (staff?.length ?? 0) > 0 && staff!.some((s) => s.hours.length), label: "Add staff and their weekly hours", to: "staff" },
    { done: (services?.length ?? 0) > 0, label: "Add services / lessons with prices", to: "services" },
    { done: biz.payment_provider !== "none", label: "Connect a payment provider (optional)", to: "payments" },
    { done: !!biz.sms_enabled, label: "Turn on text reminders (optional)", to: "sms" },
    { done: !!biz.ai_enabled, label: "Turn on the AI booking assistant (optional)", to: "ai" },
  ];

  const low = (biz.usage ?? []).filter((m: any) => m.limit > 0 && m.percent >= 80);
  return (
    <div className="stack">
      {low.length > 0 && (
        <div className={low.some((m: any) => m.percent >= 100) ? "error" : "notice"} style={low.some((m: any) => m.percent >= 100) ? undefined : { background: "var(--warn-soft)", color: "var(--warn)" }}>
          {low.map((m: any) => `${m.percent >= 100 ? "Used up" : `${m.percent}% used`}: ${m.label}`).join(" · ")}. <Link to={`${base}/billing`}>Add more or upgrade</Link>
        </div>
      )}
      <div className="grid">
        <div className="card"><div className="muted small">Upcoming bookings</div><div className="stat">{stats?.upcoming ?? "–"}</div></div>
        <div className="card"><div className="muted small">Bookings this month</div><div className="stat">{stats?.bookingsThisMonth ?? "–"}</div></div>
        <div className="card"><div className="muted small">Net revenue this month</div><div className="stat">{stats ? money(stats.revenueThisMonthCents, stats.currency) : "–"}</div></div>
        <div className="card"><div className="muted small">Plan</div><div className="stat">{biz.plan_details.name}</div></div>
      </div>
      {checklist.some((c) => !c.done) && (
        <div className="card stack">
          <h2>Get set up</h2>
          {checklist.map((c) => (
            <div key={c.to} className="row">{c.done ? "✅" : "⬜"} <Link to={`${base}/${c.to}`}>{c.label}</Link></div>
          ))}
          <p className="small muted">Share your booking link: <code>{window.location.origin}/b/{biz.slug}</code> or <Link to={`${base}/website`}>add booking to your website</Link>.</p>
        </div>
      )}
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Usage this month</h2><Link to={`${base}/billing`} className="small">Details</Link></div>
        <div className="grid">{(biz.usage ?? []).map((m: any) => <UsageMeter key={m.metric} m={m} compact />)}</div>
      </div>
      <div className="card">
        <h2>Today</h2>
        {todays?.length === 0 && <p className="muted">Nothing booked today.</p>}
        {todays?.map((b) => (
          <div key={b.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
            <strong style={{ width: 80 }}>{DateTime.fromISO(b.start).setZone(biz.timezone).toFormat("h:mm a")}</strong>
            <span>{b.customerName} — {b.serviceName} with {b.staffName}</span>
            <span className="badge">{b.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
