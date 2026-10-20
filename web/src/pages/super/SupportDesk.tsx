import { useEffect, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { caseBadge, Thread, when } from "../admin/Support";

const STATUS_LABEL: Record<string, string> = { open: "Needs reply", waiting: "Waiting on business", resolved: "Resolved" };

/** Super admin → Support: every business's cases, the conversation on each, and who's notified. */
export function SupportDesk() {
  return (
    <Routes>
      <Route index element={<CaseList />} />
      <Route path=":cid" element={<CaseDetail />} />
    </Routes>
  );
}

function CaseList() {
  const [filter, setFilter] = useState({ status: "open", q: "" });
  const { data } = useApi<any>(`/super/support?${new URLSearchParams(filter)}`);
  const counts = data?.counts ?? {};
  return (
    <div className="stack">
      <div className="card row">
        {(["open", "waiting", "resolved", ""] as const).map((s) => (
          <button key={s} className={filter.status === s ? "primary" : ""} onClick={() => setFilter({ ...filter, status: s })}>
            {s ? STATUS_LABEL[s] : "All"}{s ? ` (${counts[s] ?? 0})` : ""}
          </button>
        ))}
        <div className="spacer" />
        <label>Search<input placeholder="Case number, business, subject, email" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} /></label>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Case</th><th>Business</th><th>Subject</th><th>Status</th><th>Last update</th></tr></thead>
          <tbody>
            {data?.cases.map((c: any) => (
              <tr key={c.id}>
                <td><Link to={`/super/support/${c.id}`}>{c.ref}</Link></td>
                <td>{c.businessName}<div className="small muted">{c.replyEmail}</div></td>
                <td><Link to={`/super/support/${c.id}`}>{c.subject}</Link><div className="small muted">{c.categoryLabel} · {c.messageCount} message{c.messageCount === 1 ? "" : "s"}</div></td>
                <td><span className={`badge ${caseBadge[c.status]}`}>{STATUS_LABEL[c.status]}</span></td>
                <td className="small">{when(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.cases.length === 0 && <p className="muted">No cases here.</p>}
      </div>
      <NotifySettings />
    </div>
  );
}

function CaseDetail() {
  const { cid } = useParams();
  const { data: c, reload } = useApi<any>(`/super/support/${cid}`);
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState("waiting");
  const action = useAction();
  if (!c) return <div className="muted">Loading…</div>;

  const send = (body: string, next: string) => action.run(async () => {
    await api(`/super/support/${c.id}/messages`, { body: { body, status: next } });
    setReply(""); reload();
  });

  return (
    <div className="stack">
      <div className="card stack">
        <Link to="/super/support" className="small">← All cases</Link>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{c.ref}: {c.subject}</h2>
          <span className={`badge ${caseBadge[c.status]}`}>{STATUS_LABEL[c.status]}</span>
        </div>
        <div className="small muted">
          <Link to={`/super/businesses/${c.businessId}`}>{c.businessName}</Link> · {c.categoryLabel} · opened {when(c.createdAt)} · replies are emailed to {c.replyEmail}
        </div>
      </div>
      <Thread messages={c.messages} mine="support" />
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); send(reply, status); }}>
        {action.error && <div className="error">{action.error}</div>}
        <label>Reply to {c.businessName}
          <textarea rows={5} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="They'll get this by email, with a link back to the case." />
        </label>
        <div className="row">
          <label>After sending, mark as
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="waiting">Waiting on business</option>
              <option value="resolved">Resolved</option>
              <option value="open">Needs reply (still on us)</option>
            </select>
          </label>
          <button className="primary" disabled={action.busy || !reply.trim()}>Send reply</button>
          {c.status !== "resolved"
            ? <button type="button" disabled={action.busy} onClick={() => send("", "resolved")}>Resolve without replying</button>
            : <button type="button" disabled={action.busy} onClick={() => send("", "open")}>Reopen</button>}
        </div>
      </form>
    </div>
  );
}

function NotifySettings() {
  const { data, reload } = useApi<any>("/super/support/settings");
  const [f, setF] = useState<any>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  useEffect(() => { if (data) setF({ ...data, notifyEmails: data.notifyEmails.join(", ") }); }, [data]);
  if (!f) return null;

  const save = () => action.run(async () => {
    setResult(null);
    const notifyEmails = f.notifyEmails.split(/[,\s;]+/).map((s: string) => s.trim()).filter(Boolean);
    await api("/super/support/settings", { method: "PUT", body: { ...f, notifyEmails } });
    reload();
    setResult({ ok: true, message: "Saved." });
  });
  const test = () => action.run(async () => {
    try { setResult(await api("/super/support/settings/test", { method: "POST" })); } catch (err) { setResult({ ok: false, message: (err as Error).message }); }
  });

  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <h2 style={{ margin: 0 }}>Notifications</h2>
      <p className="small muted">These addresses are emailed about support activity, with a link straight to the case. Emails go out through the platform's email account (Settings → Email).</p>
      <label>Notify these email addresses (separate with commas)
        <input value={f.notifyEmails} onChange={(e) => setF({ ...f, notifyEmails: e.target.value })} placeholder="support@yourdomain.com, you@gmail.com" />
      </label>
      <label className="inline"><input type="checkbox" checked={f.onNewCase} onChange={(e) => setF({ ...f, onNewCase: e.target.checked })} /> When a business opens a new case</label>
      <label className="inline"><input type="checkbox" checked={f.onBusinessReply} onChange={(e) => setF({ ...f, onBusinessReply: e.target.checked })} /> When a business replies on a case</label>
      <label className="inline"><input type="checkbox" checked={f.onSupportReply} onChange={(e) => setF({ ...f, onSupportReply: e.target.checked })} /> Send a copy of replies made from here (useful if several people answer cases)</label>
      {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
      {action.error && <div className="error">{action.error}</div>}
      <div className="row">
        <button className="primary" disabled={action.busy}>Save notifications</button>
        <button type="button" disabled={action.busy} onClick={test}>Send a test email</button>
      </div>
    </form>
  );
}
