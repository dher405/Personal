import { createContext, useContext } from "react";
import { Navigate, NavLink, Route, Routes, useParams } from "react-router-dom";
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
import { Embed } from "./Embed";

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
  ["payments", "Payments"], ["sms", "Text messages"], ["ai", "AI assistant"], ["billing", "Plan & billing"], ["settings", "Settings"], ["website", "Add to website"],
];

export function AdminLayout() {
  const { bid } = useParams();
  const { data: biz, reload, error } = useApi<any>(`/admin/${bid}`);
  if (error) return <div className="container"><div className="error">{error}</div></div>;
  if (!biz) return <div className="container muted">Loading…</div>;
  const base = `/admin/${bid}`;
  return (
    <BusinessContext.Provider value={{ biz, reloadBiz: reload, base }}>
      <div className="container">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{biz.name}</h1>
          <a href={`/b/${biz.slug}`} target="_blank" rel="noreferrer">View booking page ↗</a>
        </div>
        {biz.suspended ? <div className="error" style={{ marginTop: 12 }}>This business is suspended by the platform and hidden from customers.</div> : null}
        <nav className="tabs" style={{ marginTop: 16 }}>
          {tabs.map(([path, label]) => <NavLink key={path} end to={path ? `${base}/${path}` : base}>{label}</NavLink>)}
        </nav>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="setup" element={<Dashboard />} />
          <Route path="bookings" element={<Bookings />} />
          <Route path="services" element={<Services />} />
          <Route path="staff" element={<Staff />} />
          <Route path="payments" element={<Payments />} />
          <Route path="sms" element={<SmsSettings />} />
          <Route path="ai" element={<AiSettings />} />
          <Route path="billing" element={<Billing />} />
          <Route path="settings" element={<Settings />} />
          <Route path="website" element={<Embed />} />
        </Routes>
      </div>
    </BusinessContext.Provider>
  );
}
