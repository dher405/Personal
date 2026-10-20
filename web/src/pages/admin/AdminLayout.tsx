import { createContext, useContext, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { useApi } from "../../hooks";
import { Dashboard } from "./Dashboard";
import { Bookings } from "./Bookings";
import { Services } from "./Services";
import { Staff } from "./Staff";
import { Payments } from "./Payments";
import { AiSettings } from "./AiSettings";
import { Billing } from "./Billing";
import { Settings } from "./Settings";
import { SmsSettings } from "./SmsSettings";
import { EmailSettings } from "./EmailSettings";
import { Embed } from "./Embed";
import { Calendars } from "./Calendars";

interface BizCtx { biz: any; reloadBiz: () => void; base: string }
const BusinessContext = createContext<BizCtx>(null!);
export const useBusiness = () => useContext(BusinessContext);

/** /admin — send admins straight to their (first) business. */
export function AdminHome() {
  const { session } = useAuth();
  const list = session!.businesses;
  if (list.length === 1) return <Navigate to={`/admin/${list[0].id}`} replace />;
  return (
    <div className="container">
      <h1>Your businesses</h1>
      <div className="grid">
        {list.map((b) => <NavLink key={b.id} to={`/admin/${b.id}`} className="card"><h3>{b.name}</h3><span className="muted small">/b/{b.slug}</span></NavLink>)}
      </div>
      {list.length === 0 && <p className="muted">No businesses yet.</p>}
    </div>
  );
}

const tabs = [
  ["", "Dashboard"], ["bookings", "Bookings"], ["services", "Services & prices"], ["staff", "Staff & hours"],
  ["payments", "Payments"], ["email", "Email"], ["sms", "Text messages"], ["calendars", "Calendar sync"], ["ai", "AI assistant"], ["billing", "Plan & billing"], ["settings", "Settings"], ["website", "Add to website"],
];

/** Shown on every admin tab from 80% of an allowance, so a business is warned well before it runs out. */
function UsageWarning({ usage, billing }: { usage: any[]; billing: string }) {
  const low = usage.filter((m) => m.limit > 0 && m.percent >= 80);
  if (!low.length) return null;
  const full = low.filter((m) => m.percent >= 100);
  return (
    <div className={full.length ? "error" : "notice"} style={{ marginTop: 12, ...(full.length ? {} : { background: "var(--warn-soft)", color: "var(--warn)" }) }}>
      {low.map((m) => (m.percent >= 100
        ? `You've used all ${m.limit} ${m.label} this month, so new ones are paused.`
        : `You've used ${m.used} of ${m.limit} ${m.label} this month (${m.percent}%); ${m.remaining} left.`)).join(" ")}{" "}
      <Link to={billing}><b>Add more or upgrade</b></Link>
    </div>
  );
}

export interface ExtraTab { path: string; label: string; element: ReactNode }

/**
 * A business's admin screens. Business admins see them at /admin/:bid; the super admin sees the very
 * same screens inside Super admin → Businesses (basePath), plus platform-only tabs (extraTabs).
 */
export function AdminLayout({ basePath, extraTabs = [], embedded = false, header }: { basePath?: string; extraTabs?: ExtraTab[]; embedded?: boolean; header?: ReactNode }) {
  const { bid } = useParams();
  const { data: biz, reload, error } = useApi<any>(`/admin/${bid}`);
  if (error) return <div className={embedded ? "" : "container"}><div className="error">{error}</div></div>;
  if (!biz) return <div className={embedded ? "muted" : "container muted"}>Loading…</div>;
  const base = basePath ?? `/admin/${bid}`;
  return (
    <BusinessContext.Provider value={{ biz, reloadBiz: reload, base }}>
      <div className={embedded ? "" : "container"}>
        {header}
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{biz.name}</h1>
          <a href={`/b/${biz.slug}`} target="_blank" rel="noreferrer">View booking page ↗</a>
        </div>
        {biz.suspended ? <div className="error" style={{ marginTop: 12 }}>This business is suspended by the platform and hidden from customers.</div> : null}
        <UsageWarning usage={biz.usage ?? []} billing={`${base}/billing`} />
        <nav className="tabs" style={{ marginTop: 16 }}>
          {tabs.map(([path, label]) => <NavLink key={path} end to={path ? `${base}/${path}` : base}>{label}</NavLink>)}
          {extraTabs.map((t) => <NavLink key={t.path} to={`${base}/${t.path}`}>{t.label}</NavLink>)}
        </nav>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="setup" element={<Dashboard />} />
          <Route path="bookings" element={<Bookings />} />
          <Route path="services" element={<Services />} />
          <Route path="staff" element={<Staff />} />
          <Route path="payments" element={<Payments />} />
          <Route path="email" element={<EmailSettings />} />
          <Route path="sms" element={<SmsSettings />} />
          <Route path="ai" element={<AiSettings />} />
          <Route path="billing" element={<Billing />} />
          <Route path="settings" element={<Settings />} />
          <Route path="website" element={<Embed />} />
          <Route path="calendars" element={<Calendars />} />
          {extraTabs.map((t) => <Route key={t.path} path={t.path} element={t.element} />)}
        </Routes>
      </div>
    </BusinessContext.Provider>
  );
}
