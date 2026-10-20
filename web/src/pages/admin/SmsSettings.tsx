import { useState } from "react";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { Copy, Steps, savedHint } from "../../components/Setup";

/** The business's own Twilio account: every text to its customers (and to the owner and staff) comes from its number. */
function TwilioAccount({ onChange }: { onChange: () => void }) {
  const { biz, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/communications`);
  const [f, setF] = useState<any>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  if (!data) return null;
  const t = data.sms;
  const form = f ?? { provider: t.provider === "none" ? "twilio" : t.provider, accountSid: t.accountSid, authToken: "", messagingServiceSid: t.messagingServiceSid, fromNumber: t.fromNumber };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...form, [k]: e.target.value });
  const save = (provider = form.provider) => action.run(async () => {
    setResult(null);
    await api(`/admin/${biz.id}/communications/sms`, { method: "PUT", body: { ...form, provider } });
    setF(null); reload(); reloadBiz(); onChange();
  });
  const check = () => action.run(async () => {
    try { setResult(await api(`/admin/${biz.id}/communications/sms/check`, { method: "POST" })); } catch (err) { setResult({ ok: false, message: (err as Error).message }); }
  });

  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Your Twilio account</h2>
        <span className={`badge ${t.configured ? "ok" : "warn"}`}>{t.configured ? (t.live ? `Connected${t.fromNumber ? `: ${t.fromNumber}` : ""}` : "Test mode") : "Not connected: texting is hidden"}</span>
      </div>
      <p className="small muted">
        Texts to your customers come from <b>your own Twilio number</b>, and Twilio bills you directly for them. Until it's connected, customers aren't
        offered texts anywhere (booking page, website calendar, app or chat).
      </p>
      {action.error && <div className="error">{action.error}</div>}
      <label>Texting
        <select value={form.provider} onChange={set("provider")}>
          <option value="twilio">My Twilio account</option>
          {data.testModeAllowed && <option value="test">Test mode (texts shown in the log, never sent)</option>}
        </select>
      </label>
      {form.provider === "twilio" && (
        <div className="stack">
          <Steps>
            <li>Sign up at <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">twilio.com</a> and buy a phone number that can send SMS.</li>
            <li>US numbers must be registered before carriers deliver texts: in the Twilio Console, complete <b>A2P 10DLC</b> registration for a local number, or <b>toll-free verification</b> for a toll-free number. This can take a few days.</li>
            <li>On the <a href="https://console.twilio.com" target="_blank" rel="noreferrer">Twilio Console</a> home page, copy your <b>Account SID</b> and <b>Auth token</b>.</li>
            <li>Under <b>Phone Numbers → Manage → Active numbers</b>, open your number. Under <b>Messaging → A message comes in</b>, choose Webhook, paste the address below, set HTTP POST, and save. (Using a Messaging Service instead? Put it in the service's Integration settings.)</li>
          </Steps>
          <label>Incoming messages webhook<Copy value={t.webhooks.incoming} /></label>
          <div className="form-grid">
            <label>Account SID<input value={form.accountSid} onChange={set("accountSid")} placeholder="AC…" /></label>
            <label>Auth token<input type="password" autoComplete="off" value={form.authToken} onChange={set("authToken")} placeholder={savedHint(t.authToken, "")} /></label>
            <label>Your Twilio phone number<input type="tel" value={form.fromNumber} onChange={set("fromNumber")} placeholder="+15551234567" /></label>
            <label>Messaging Service SID (optional)<input value={form.messagingServiceSid} onChange={set("messagingServiceSid")} placeholder="MG… (used instead of the number)" /></label>
          </div>
        </div>
      )}
      {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
      <div className="row">
        <button className="primary" disabled={action.busy}>Save Twilio settings</button>
        <button type="button" disabled={action.busy || !t.configured} title={t.configured ? "" : "Save first"} onClick={check}>Check connection</button>
        {t.provider !== "none" && <button type="button" disabled={action.busy} onClick={() => confirm("Disconnect Twilio? Texting will switch off and customers won't be offered texts.") && save("none")}>Disconnect</button>}
      </div>
    </form>
  );
}

const statusBadge: Record<string, string> = { sent: "ok", delivered: "ok", simulated: "", received: "", queued: "", skipped: "warn", failed: "bad", undelivered: "bad" };

export function SmsSettings() {
  const { biz, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/sms`);
  const [form, setForm] = useState({
    sms_enabled: !!biz.sms_enabled,
    sms_reminder_hours: biz.sms_reminder_hours,
    sms_admin_phone: biz.sms_admin_phone ?? "",
    sms_admin_alerts: !!biz.sms_admin_alerts,
    sms_agenda_hour: biz.sms_agenda_hour === null ? "" : String(biz.sms_agenda_hour),
    sms_staff_reminder_min: biz.sms_staff_reminder_min === null ? "" : String(biz.sms_staff_reminder_min),
  });
  const [sim, setSim] = useState({ from: "", body: "" });
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const configured = data?.configured ?? biz.sms_configured;

  const save = () => action.run(async () => {
    await api(`/admin/${biz.id}`, {
      method: "PATCH",
      body: {
        ...form,
        sms_admin_phone: form.sms_admin_phone || null,
        sms_agenda_hour: form.sms_agenda_hour === "" ? null : Number(form.sms_agenda_hour),
        sms_staff_reminder_min: form.sms_staff_reminder_min === "" ? null : Number(form.sms_staff_reminder_min),
      },
    });
    reloadBiz(); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });

  return (
    <div className="stack">
      <TwilioAccount onChange={reload} />
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <fieldset className="card stack" disabled={!configured} style={{ border: undefined, margin: 0, opacity: configured ? 1 : 0.55 }}>
          <h2>Text reminders & alerts</h2>
          {!configured && <p className="small muted">Connect your Twilio account above to use these.</p>}
          {configured && !data?.live && <p className="small muted">Test mode: texts are not really sent. They appear in the log below so you can try everything out.</p>}
          {action.error && <div className="error">{action.error}</div>}
          <label className="inline"><input type="checkbox" checked={form.sms_enabled} onChange={(e) => setForm({ ...form, sms_enabled: e.target.checked })} /> Send text messages</label>
          <label>Remind customers this many hours before (comma-separated)
            <input value={form.sms_reminder_hours} onChange={(e) => setForm({ ...form, sms_reminder_hours: e.target.value })} placeholder="24,2" />
          </label>
          <p className="small muted">Customers only get texts if they tick "Text me" when booking. They can reply <b>C</b> to confirm, <b>R</b> to pick a new time, or <b>X</b> to cancel{biz.ai_chat_active ? ", or just write a message and the AI assistant will help" : ""}. STOP always opts them out.</p>
          <h3>For you</h3>
          <label>Your mobile number (alerts and agenda)
            <input type="tel" value={form.sms_admin_phone} onChange={(e) => setForm({ ...form, sms_admin_phone: e.target.value })} placeholder="(555) 123-4567" />
          </label>
          <label className="inline"><input type="checkbox" checked={form.sms_admin_alerts} onChange={(e) => setForm({ ...form, sms_admin_alerts: e.target.checked })} /> Text me when customers book, confirm, reschedule or cancel</label>
          <label>Morning agenda text at
            <select value={form.sms_agenda_hour} onChange={(e) => setForm({ ...form, sms_agenda_hour: e.target.value })}>
              <option value="">Off</option>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{DateTime.fromObject({ hour: h }).toFormat("h a")}</option>)}
            </select>
          </label>
          <label>Text staff before each appointment
            <select value={form.sms_staff_reminder_min} onChange={(e) => setForm({ ...form, sms_staff_reminder_min: e.target.value })}>
              <option value="">Off</option>
              {[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`} before</option>)}
            </select>
          </label>
          <p className="small muted">Text your own number <b>TODAY</b> or <b>TOMORROW</b> for your schedule{biz.plan_details.aiChat ? `, or ask in plain words ("move Pat to Friday 3pm")` : ""}.</p>
          <div className="row">
            <button className="primary" disabled={action.busy} onClick={save}>Save</button>
            <button disabled={action.busy || !biz.sms_admin_phone} onClick={() => action.run(async () => { await api(`/admin/${biz.id}/sms/test`, { body: {} }); reload(); })}>Send me a test text</button>
            {saved && <span className="notice small">Saved</span>}
          </div>
        </fieldset>

        {configured && !data?.live && (
          <div className="card stack">
            <h2>Try a reply</h2>
            <p className="small muted">Pretend a phone texted your number. Use a customer's phone from a booking (they must have agreed to texts), or your own number to try the admin commands.</p>
            <label>From<input type="tel" value={sim.from} onChange={(e) => setSim({ ...sim, from: e.target.value })} placeholder="+15557770001" /></label>
            <label>Message<input value={sim.body} onChange={(e) => setSim({ ...sim, body: e.target.value })} placeholder="C, R, X, 1… or TODAY" /></label>
            <div><button disabled={!sim.from || !sim.body || action.busy} onClick={() => action.run(async () => {
              await api(`/admin/${biz.id}/sms/simulate`, { body: sim });
              setSim({ ...sim, body: "" }); reload();
            })}>Send</button></div>
          </div>
        )}
      </div>

      <div className="card table-wrap">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Message log</h2><button onClick={reload}>Refresh</button></div>
        <table>
          <thead><tr><th>When</th><th>Direction</th><th>Phone</th><th>Message</th><th>Status</th></tr></thead>
          <tbody>
            {data?.messages.map((m: any) => (
              <tr key={m.id}>
                <td className="small">{DateTime.fromSQL(m.created_at, { zone: "utc" }).setZone(biz.timezone).toFormat("d LLL h:mm a")}</td>
                <td className="small">{m.direction === "inbound" ? "← in" : "→ out"} <span className="muted">{m.audience} · {m.kind.replace(/_/g, " ")}</span></td>
                <td className="small">{m.direction === "inbound" ? m.from_phone : m.to_phone}</td>
                <td style={{ whiteSpace: "pre-wrap", maxWidth: 420 }}>{m.body}</td>
                <td><span className={`badge ${statusBadge[m.status] ?? ""}`}>{m.status}</span>{m.error && <div className="small muted">{m.error}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.messages.length === 0 && <p className="muted">No texts yet.</p>}
      </div>
    </div>
  );
}
