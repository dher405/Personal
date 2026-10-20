import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";
import { Steps, savedHint } from "../../components/Setup";

/** Common mail services, so most owners only need their address and an app password. */
const PRESETS: Record<string, { label: string; host: string; port: number; security: "ssl" | "starttls"; help: React.ReactNode }> = {
  gmail: {
    label: "Gmail or Google Workspace", host: "smtp.gmail.com", port: 465, security: "ssl",
    help: <>Turn on <b>2-Step Verification</b> for the Google account, then create an <b>app password</b> at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a> and paste it below (not your normal password). The From address must be that Gmail address, or an address added under Gmail → Settings → Accounts → "Send mail as".</>,
  },
  microsoft: {
    label: "Microsoft 365 or Outlook", host: "smtp.office365.com", port: 587, security: "starttls",
    help: <>Use the mailbox's address and password (or an app password if it has two-step verification). On Microsoft 365, your administrator may need to turn on <b>Authenticated SMTP</b> for this mailbox in the Microsoft 365 admin center. If Microsoft won't allow it, use Resend or your web host's email instead.</>,
  },
  zoho: { label: "Zoho Mail", host: "smtp.zoho.com", port: 465, security: "ssl", help: <>Use your Zoho address and password, or an app-specific password if two-factor sign-in is on.</> },
  icloud: { label: "iCloud Mail", host: "smtp.mail.me.com", port: 587, security: "starttls", help: <>Create an <b>app-specific password</b> at <a href="https://account.apple.com" target="_blank" rel="noreferrer">account.apple.com</a> → Sign-In and Security, and use your iCloud address as the user name.</> },
  yahoo: { label: "Yahoo Mail", host: "smtp.mail.yahoo.com", port: 465, security: "ssl", help: <>Create an <b>app password</b> in Yahoo Account Security and paste it below.</> },
  other: { label: "My web host or another provider", host: "", port: 587, security: "starttls", help: <>Your host's help pages list the "outgoing mail (SMTP)" server, port and security. GoDaddy, Bluehost, Squarespace Email and most others work.</> },
};

const presetFor = (host: string) => Object.entries(PRESETS).find(([, p]) => p.host && p.host === host)?.[0] ?? (host ? "other" : "gmail");
const statusBadge: Record<string, string> = { sent: "ok", failed: "bad", not_sent: "warn" };

export function EmailSettings() {
  const { biz, reloadBiz } = useBusiness();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/communications`);
  const [f, setF] = useState<any>(null);
  const [preset, setPreset] = useState("gmail");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!data || f) return;
    const e = data.email;
    const id = presetFor(e.smtpHost);
    // Nothing saved yet: start with the first preset's server settings filled in.
    const start = e.smtpHost ? {} : { smtpHost: PRESETS[id].host, smtpPort: PRESETS[id].port, smtpSecurity: PRESETS[id].security };
    setF({ ...e, provider: e.provider === "none" ? "smtp" : e.provider, smtpPass: "", resendApiKey: "", smtpPort: e.smtpPort ?? "", ...start });
    setPreset(id);
  }, [data]);
  if (!data || !f) return <div className="muted">Loading…</div>;

  const e = data.email;
  const set = (k: string) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: ev.target.value });
  const choosePreset = (id: string) => {
    setPreset(id);
    const p = PRESETS[id];
    setF({ ...f, smtpHost: p.host || f.smtpHost, smtpPort: p.port, smtpSecurity: p.security, smtpUser: f.smtpUser || f.fromEmail });
  };

  const save = (provider = f.provider) => action.run(async () => {
    setResult(null);
    await api(`/admin/${biz.id}/communications/email`, {
      method: "PUT",
      body: {
        provider, fromName: f.fromName, fromEmail: f.fromEmail, replyTo: f.replyTo,
        smtpHost: f.smtpHost, smtpPort: f.smtpPort === "" ? null : Number(f.smtpPort), smtpSecurity: f.smtpSecurity,
        smtpUser: f.smtpUser, smtpPass: f.smtpPass, resendApiKey: f.resendApiKey,
      },
    });
    setF(null); reload(); reloadBiz();
  });

  const sendTest = () => action.run(async () => {
    setResult(null);
    try {
      setResult(await api(`/admin/${biz.id}/communications/email/test`, { body: {} }));
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    }
    reload();
  });

  return (
    <div className="stack">
      <form className="card stack" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Emails to your customers</h2>
          <span className={`badge ${e.ready ? "ok" : "warn"}`}>{e.ready ? `Sending from ${e.fromEmail}` : "Not set up: customers get no emails"}</span>
        </div>
        <p className="small muted">
          Booking confirmations (with a calendar invite), changes and cancellations are sent from <b>your own email address</b>, through your own
          email account, so replies come straight to you. Until this is set up, customers don't get emails; the log below shows what would have been sent.
        </p>
        {action.error && <div className="error">{action.error}</div>}

        <div className="form-grid">
          <label>Send with
            <select value={f.provider} onChange={set("provider")}>
              <option value="smtp">My email account (Gmail, Microsoft 365, my web host…)</option>
              <option value="resend">Resend (for a custom domain)</option>
            </select>
          </label>
          <label>From name<input value={f.fromName} onChange={set("fromName")} placeholder={biz.name} /></label>
          <label>From address<input type="email" required value={f.fromEmail} onChange={set("fromEmail")} placeholder="hello@yourbusiness.com" /></label>
          <label>Replies go to (optional)<input type="email" value={f.replyTo} onChange={set("replyTo")} placeholder="Same as the From address" /></label>
        </div>
        {/* Customers answer booking emails with Reply; make sure that lands in an inbox someone reads. */}
        {(f.replyTo || f.fromEmail) && (/^(no-?reply|do-?not-?reply|noreply)@/i.test(f.replyTo || f.fromEmail)
          ? <div className="error small">Customers who reply to a booking email would write to <b>{f.replyTo || f.fromEmail}</b>, which looks like an address nobody reads. Put your real inbox under “Replies go to”.</div>
          : <p className="small muted" style={{ margin: 0 }}>When customers reply to a booking email, it goes to <b>{f.replyTo || f.fromEmail}</b>.</p>)}

        {f.provider === "smtp" && (
          <div className="stack">
            <label>Email service
              <select value={preset} onChange={(ev) => choosePreset(ev.target.value)}>
                {Object.entries(PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
              </select>
            </label>
            <p className="small muted">{PRESETS[preset].help}</p>
            <div className="form-grid">
              <label>Outgoing mail (SMTP) server<input required value={f.smtpHost} onChange={set("smtpHost")} placeholder="smtp.yourhost.com" /></label>
              <label>Port<input type="number" value={f.smtpPort} onChange={set("smtpPort")} placeholder="587" /></label>
              <label>Security
                <select value={f.smtpSecurity || "starttls"} onChange={set("smtpSecurity")}>
                  <option value="starttls">STARTTLS (usually port 587)</option>
                  <option value="ssl">SSL/TLS (usually port 465)</option>
                </select>
              </label>
              <label>User name<input required value={f.smtpUser} onChange={set("smtpUser")} placeholder="Usually your full email address" /></label>
              <label>Password or app password
                <input type="password" autoComplete="new-password" required={!e.smtpPass} value={f.smtpPass} onChange={set("smtpPass")} placeholder={savedHint(e.smtpPass, "")} />
              </label>
            </div>
          </div>
        )}

        {f.provider === "resend" && (
          <div className="stack">
            <Steps>
              <li>Create a free account at <a href="https://resend.com" target="_blank" rel="noreferrer">resend.com</a>.</li>
              <li>Under <b>Domains</b>, add your business's domain (for example yourbusiness.com) and add the DNS records it shows at your domain host. Wait until it says <b>Verified</b>.</li>
              <li>Under <b>API Keys</b>, create a key with "Sending access" and paste it below. Use a From address at that domain.</li>
            </Steps>
            <label>Resend API key
              <input type="password" autoComplete="off" required={!e.resendApiKey} value={f.resendApiKey} onChange={set("resendApiKey")} placeholder={savedHint(e.resendApiKey, "re_…")} />
            </label>
          </div>
        )}

        {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
        <div className="row">
          <button className="primary" disabled={action.busy}>Save email settings</button>
          <button type="button" disabled={action.busy || !e.ready} title={e.ready ? "" : "Save first"} onClick={sendTest}>Send me a test email</button>
          {e.provider !== "none" && (
            <button type="button" disabled={action.busy} onClick={() => confirm("Stop sending emails to customers?") && save("none")}>Turn off customer emails</button>
          )}
        </div>
        <p className="small muted">Passwords and keys are stored encrypted and never shown again; leave a box blank to keep the saved one. Emails to you (new-booking alerts) still come from Slotwise.</p>
      </form>

      <div className="card table-wrap">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Email log</h2><button onClick={reload}>Refresh</button></div>
        <table>
          <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            {data.emails.map((m: any) => (
              <tr key={m.id}>
                <td className="small">{DateTime.fromSQL(m.created_at, { zone: "utc" }).setZone(biz.timezone).toFormat("d LLL h:mm a")}</td>
                <td className="small">{m.to_email}</td>
                <td><details><summary>{m.subject}</summary><div className="small" style={{ whiteSpace: "pre-wrap", maxWidth: 520 }}>{m.body}</div></details></td>
                <td><span className={`badge ${statusBadge[m.status] ?? ""}`}>{m.status === "not_sent" ? "not sent" : m.status}</span>{m.error && <div className="small muted">{m.error}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.emails.length === 0 && <p className="muted">No customer emails yet.</p>}
      </div>
    </div>
  );
}
