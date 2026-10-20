import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { Copy } from "../../components/Setup";

const NAMES: Record<string, string> = { google: "Google Calendar", microsoft: "Outlook" };


export function Calendars() {
  const { biz } = useBusiness();
  const [params] = useSearchParams();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/calendars`);
  const action = useAction();
  if (!data) return <div className="muted">Loading…</div>;

  const connect = (staffId: string, provider: string) => action.run(async () => {
    window.location.href = (await api(`/admin/${biz.id}/staff/${staffId}/calendar/${provider}/connect`, { method: "POST" })).url;
  });
  const patch = (cid: string, body: object) => action.run(async () => { await api(`/admin/${biz.id}/calendar-connections/${cid}`, { method: "PATCH", body }); reload(); });
  const anyProvider = data.providers.google || data.providers.microsoft;

  return (
    <div className="stack">
      {params.get("connected") && <div className="notice">{NAMES[params.get("connected")!]} connected. Upcoming bookings are being copied into it now.</div>}
      {params.get("calendarError") && <div className="error">{params.get("calendarError")}</div>}
      {action.error && <div className="error">{action.error}</div>}

      <div className="card stack">
        <h2>Connect your Google or Outlook calendar</h2>
        <p className="small muted">
          Each booking appears in the connected calendar the moment it's made, moved or cancelled, with a reminder on your phone.
          Anything already in that calendar (a dentist appointment, a day off) blocks those times on your booking page.
          Make changes to bookings here, not in Google or Outlook, so customers are told.
        </p>
        {!anyProvider && <div className="error">Calendar connections aren't switched on for this platform yet. You can still use the subscribe link below.</div>}
        {data.staff.map((s: any) => (
          <div key={s.id} className="card stack" style={{ marginBottom: 0 }}>
            <div className="row"><strong>{s.name}</strong>{!s.active && <span className="badge">inactive</span>}</div>
            {s.connections.map((c: any) => (
              <div key={c.id} className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div className="row">
                  <span className="badge ok">{NAMES[c.provider]}</span>
                  <span>{c.account_email}</span>
                  <span className="small muted">
                    {c.events} booking{c.events === 1 ? "" : "s"} synced
                    {c.last_synced_at ? ` · last sync ${DateTime.fromSQL(c.last_synced_at, { zone: "utc" }).toRelative()}` : ""}
                  </span>
                </div>
                {c.last_error && <div className="error small">Problem: {String(c.last_error).replace(/\.+$/, "")}. Try <b>Sync now</b>, or disconnect and connect again.</div>}
                <div className="row">
                  <label className="inline"><input type="checkbox" checked={!!c.check_busy} onChange={(e) => patch(c.id, { check_busy: e.target.checked })} /> Block times that are busy in this calendar</label>
                  <label className="inline">Reminder
                    <select style={{ width: "auto" }} value={c.reminder_min} onChange={(e) => patch(c.id, { reminder_min: Number(e.target.value) })}>
                      {[0, 10, 15, 30, 60, 120, 1440].map((m) => <option key={m} value={m}>{m === 0 ? "at start time" : m < 60 ? `${m} min before` : m === 1440 ? "1 day before" : `${m / 60} hour${m > 60 ? "s" : ""} before`}</option>)}
                    </select>
                  </label>
                </div>
                <div className="row">
                  <button disabled={action.busy} onClick={() => action.run(async () => { await api(`/admin/${biz.id}/calendar-connections/${c.id}/resync`, { method: "POST" }); reload(); })}>Sync now</button>
                  <button className="danger" disabled={action.busy} onClick={() => confirm(`Disconnect ${NAMES[c.provider]}? Upcoming bookings will be removed from that calendar.`) && action.run(async () => { await api(`/admin/${biz.id}/calendar-connections/${c.id}`, { method: "DELETE" }); reload(); })}>Disconnect</button>
                </div>
              </div>
            ))}
            <div className="row">
              {data.providers.google && !s.connections.some((c: any) => c.provider === "google") && <button onClick={() => connect(s.id, "google")}>Connect Google Calendar</button>}
              {data.providers.microsoft && !s.connections.some((c: any) => c.provider === "microsoft") && <button onClick={() => connect(s.id, "microsoft")}>Connect Outlook</button>}
            </div>
          </div>
        ))}
        <p className="small muted">Connecting a staff member's calendar? They can sign in to their own Google or Microsoft account on the screen that opens.</p>
      </div>

      <div className="card stack">
        <h2>Or subscribe to your bookings</h2>
        <p className="small muted">
          Works with any calendar app (Google, Outlook, Apple) without connecting an account. It's read-only, and
          calendar apps only check for changes every few hours, so use the connection above for real-time updates.
          Keep these addresses private: anyone with one can see those bookings.
        </p>
        <label>All bookings<Copy value={data.feed.all} /></label>
        {data.staff.map((s: any) => <label key={s.id}>{s.name} only<Copy value={s.feedUrl} /></label>)}
        <div><button onClick={() => confirm("Make new addresses? The current ones will stop working in any calendar that uses them.") && action.run(async () => { await api(`/admin/${biz.id}/calendar-feed/regenerate`, { method: "POST" }); reload(); })}>Make new addresses</button></div>
      </div>

      <div className="card stack">
        <h2>Email alerts</h2>
        <label className="inline">
          <input type="checkbox" checked={data.emailAdminAlerts} onChange={(e) => action.run(async () => { await api(`/admin/${biz.id}/calendar-alerts`, { method: "PUT", body: { emailAdminAlerts: e.target.checked } }); reload(); })} />
          Email me (every admin of this business) when customers book, confirm, reschedule or cancel
        </label>
      </div>
    </div>
  );
}
