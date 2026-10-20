import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { Steps, savedHint } from "../../components/Setup";
import { WHERE } from "./Services";

const TOOLS: [string, string][] = [
  ["none", "Not set up"],
  ["google_meet", "Google Meet"],
  ["teams", "Microsoft Teams"],
  ["zoom", "Zoom"],
  ["ringcentral", "RingCentral Video"],
  ["custom", "The same link every time (any tool)"],
];

/** Online meetings: which tool makes the meeting link for online appointments, and its credentials. */
export function MeetingSettings() {
  const { biz, base, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/meetings`);
  const [f, setF] = useState<any>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  useEffect(() => { if (data && !f) setF({ ...data, zoomClientSecret: "", rcClientSecret: "", rcJwt: "" }); }, [data]);
  if (!data || !f) return <div className="muted">Loading…</div>;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = () => action.run(async () => {
    setResult(null);
    await api(`/admin/${biz.id}/meetings`, { method: "PUT", body: {
      provider: f.provider, zoomAccountId: f.zoomAccountId, zoomClientId: f.zoomClientId, zoomClientSecret: f.zoomClientSecret,
      rcClientId: f.rcClientId, rcClientSecret: f.rcClientSecret, rcJwt: f.rcJwt, customUrl: f.customUrl,
    } });
    setF(null); reload(); reloadBiz();
  });
  const test = () => action.run(async () => {
    try { setResult(await api(`/admin/${biz.id}/meetings/test`, { method: "POST" })); } catch (err) { setResult({ ok: false, message: (err as Error).message }); }
  });
  const calendarKind = f.provider === "google_meet" ? "google" : f.provider === "teams" ? "microsoft" : null;

  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Online meetings</h2>
          <span className={`badge ${data.ready ? "ok" : "warn"}`}>{data.ready ? data.label : "Not set up"}</span>
        </div>
        <p className="small muted">
          For lessons and appointments held online. When an online booking is confirmed, Slotwise creates a meeting with your tool and puts the
          join link in the customer's confirmation email, calendar invite, text and booking page, and in your own calendar. Moving the booking
          moves the meeting; cancelling deletes it. Choose which services are online (or the customer's choice) in <Link to={`${base}/services`}>Services & prices</Link>.
        </p>
        {action.error && <div className="error">{action.error}</div>}
        <label>Meeting tool
          <select value={f.provider} onChange={(e) => { setF({ ...f, provider: e.target.value }); setResult(null); }}>
            {TOOLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>

        {calendarKind && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              {f.provider === "google_meet" ? "Google Meet" : "Teams"} links are made on the event in each staff member's own {calendarKind === "google" ? "Google Calendar" : "Outlook calendar"},
              so there's nothing else to enter. Each person who takes online bookings connects their calendar under <Link to={`${base}/calendars`}>Calendar sync</Link>.
              {f.provider === "teams" && " Teams meetings need a Microsoft 365 work or school account with Teams; personal Outlook.com accounts can't create them."}
            </p>
            <table>
              <tbody>
                {data.staff.map((s: any) => (
                  <tr key={s.id}><td>{s.name}</td><td>{s.calendars.includes(calendarKind)
                    ? <span className="badge ok">Connected: links will be created</span>
                    : <span className="badge warn">Not connected: <Link to={`${base}/calendars`}>connect</Link></span>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {f.provider === "zoom" && (
          <div className="stack">
            <Steps>
              <li>Sign in to the <a href="https://marketplace.zoom.us" target="_blank" rel="noreferrer">Zoom App Marketplace</a> with your Zoom account (a paid plan is needed for meetings over 40 minutes).</li>
              <li>Click <b>Develop → Build App</b>, choose <b>Server-to-Server OAuth App</b>, and name it "Slotwise".</li>
              <li>Under <b>Scopes</b>, add the scopes for creating, updating and deleting meetings and for reading your user (search "meeting" and "user").</li>
              <li>Click <b>Activate</b>, then copy the <b>Account ID</b>, <b>Client ID</b> and <b>Client secret</b> from App Credentials below.</li>
            </Steps>
            <div className="form-grid">
              <label>Account ID<input value={f.zoomAccountId} onChange={set("zoomAccountId")} /></label>
              <label>Client ID<input value={f.zoomClientId} onChange={set("zoomClientId")} /></label>
              <label>Client secret<input type="password" autoComplete="off" value={f.zoomClientSecret} onChange={set("zoomClientSecret")} placeholder={savedHint(data.zoomClientSecret, "")} /></label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Meetings are created on the Zoom account that made the app, with a waiting room so you let each customer in.</p>
          </div>
        )}

        {f.provider === "ringcentral" && (
          <div className="stack">
            <Steps>
              <li>Sign in to the <a href="https://developers.ringcentral.com" target="_blank" rel="noreferrer">RingCentral Developer Console</a> with your RingCentral account and click <b>Register App</b>.</li>
              <li>Choose a <b>REST API App</b> with auth type <b>JWT auth flow</b> (server-side, no user interface), and add the <b>Video</b> permission.</li>
              <li>Copy the app's <b>Client ID</b> and <b>Client secret</b>.</li>
              <li>Under your profile → <b>Credentials</b>, create a <b>JWT credential</b> for this app and copy it.</li>
            </Steps>
            <div className="form-grid">
              <label>Client ID<input value={f.rcClientId} onChange={set("rcClientId")} /></label>
              <label>Client secret<input type="password" autoComplete="off" value={f.rcClientSecret} onChange={set("rcClientSecret")} placeholder={savedHint(data.rcClientSecret, "")} /></label>
            </div>
            <label>JWT credential<textarea rows={3} value={f.rcJwt} onChange={set("rcJwt")} placeholder={data.rcJwt ? `${data.rcJwt} saved. Paste a new one to replace it.` : "eyJ…"} /></label>
          </div>
        )}

        {f.provider === "custom" && (
          <label>Meeting link<input type="url" value={f.customUrl} onChange={set("customUrl")} placeholder="https://zoom.us/j/1234567890, https://meet.google.com/abc-defg-hij, https://v.ringcentral.com/join/…" />
            <span className="small muted">Your personal meeting room. Every online booking uses this one link, so use a waiting room or lobby to keep sessions private.</span>
          </label>
        )}

        {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
        <div className="row">
          <button className="primary" disabled={action.busy}>Save</button>
          <button type="button" disabled={action.busy || f.provider !== data.provider || f.provider === "none"} title={f.provider !== data.provider ? "Save first" : ""} onClick={test}>Test</button>
        </div>
        <p className="small muted">Secrets are stored encrypted and never shown again; leave a box blank to keep the saved one.</p>
      </form>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Online services</h2>
        {data.onlineServices.length
          ? data.onlineServices.map((s: any) => <div key={s.id}>{s.name} <span className="small muted">{WHERE[s.location_mode]}</span></div>)
          : <p className="muted" style={{ margin: 0 }}>None yet. In <Link to={`${base}/services`}>Services & prices</Link>, edit a service and set <b>Where</b> to Online or Customer chooses.</p>}
      </div>
    </div>
  );
}
