import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

export const caseBadge: Record<string, string> = { open: "warn", waiting: "ok", resolved: "" };
const STATUS_FOR_BUSINESS: Record<string, string> = { open: "With support", waiting: "Support replied", resolved: "Resolved" };
export const when = (sql: string) => DateTime.fromSQL(sql, { zone: "utc" }).toLocal().toFormat("d LLL yyyy, h:mm a");

/** The conversation on one case, oldest first. */
export function Thread({ messages, mine }: { messages: any[]; mine: "business" | "support" }) {
  return (
    <div className="stack">
      {messages.map((m) => (
        <div key={m.id} className="card" style={m.author_role === mine ? {} : { borderLeft: "3px solid var(--accent)" }}>
          <div className="small muted">{m.author_role === "support" ? "Slotwise support" : m.author_name} · {when(m.created_at)}</div>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{m.body}</div>
        </div>
      ))}
    </div>
  );
}

/** Help & support for a business: the owner guide, its support cases, and a form to open a new one. */
export function Support() {
  const { biz, base } = useBusiness();
  const { session } = useAuth();
  const { data, reload } = useApi<any>(`/admin/${biz.id}/support`);
  const [f, setF] = useState({ subject: "", category: "other", body: "", replyEmail: session?.user.email ?? "" });
  const action = useAction();
  const navigate = useNavigate();

  const open = () => action.run(async () => {
    const c = await api(`/admin/${biz.id}/support`, { body: f });
    reload();
    navigate(`${base}/support/${c.id}`);
  });

  return (
    <div className="stack">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div><h2 style={{ margin: 0 }}>Help & support</h2><p className="small muted" style={{ margin: "4px 0 0" }}>Most answers are in the owner guide. Still stuck? Open a case and we'll reply by email.</p></div>
        <a className="btn" href="/guide" target="_blank" rel="noreferrer">📘 Owner guide</a>
      </div>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); open(); }}>
        <h2 style={{ margin: 0 }}>Open a support case</h2>
        {action.error && <div className="error">{action.error}</div>}
        <div className="form-grid">
          <label>What's it about?
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {data && Object.entries(data.categories).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
            </select>
          </label>
          <label>Email us back at<input type="email" required value={f.replyEmail} onChange={(e) => setF({ ...f, replyEmail: e.target.value })} /></label>
        </div>
        <label>Subject<input required minLength={3} maxLength={150} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Bookings aren't showing in my Google Calendar" /></label>
        <label>What's happening?
          <textarea required minLength={5} rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })}
            placeholder="What you were doing, what you expected, and what happened instead. Booking codes and error messages help." />
        </label>
        <div><button className="primary" disabled={action.busy}>Send to support</button></div>
        <p className="small muted">You'll get a case number by email straight away, and an email each time we reply.</p>
      </form>

      <div className="card table-wrap">
        <h2>Your cases</h2>
        <table>
          <thead><tr><th>Case</th><th>Subject</th><th>Status</th><th>Last update</th></tr></thead>
          <tbody>
            {data?.cases.map((c: any) => (
              <tr key={c.id}>
                <td><Link to={`${base}/support/${c.id}`}>{c.ref}</Link></td>
                <td><Link to={`${base}/support/${c.id}`}>{c.subject}</Link><div className="small muted">{c.categoryLabel}</div></td>
                <td><span className={`badge ${caseBadge[c.status]}`}>{STATUS_FOR_BUSINESS[c.status]}</span></td>
                <td className="small">{when(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.cases.length === 0 && <p className="muted">No cases yet.</p>}
      </div>
    </div>
  );
}

export function SupportCase() {
  const { biz, base } = useBusiness();
  const { cid } = useParams();
  const { data: c, reload } = useApi<any>(`/admin/${biz.id}/support/${cid}`);
  const [reply, setReply] = useState("");
  const action = useAction();
  if (!c) return <div className="muted">Loading…</div>;

  const send = (resolved = false) => action.run(async () => {
    await api(`/admin/${biz.id}/support/${c.id}/messages`, { body: { body: reply, resolved } });
    setReply(""); reload();
  });

  return (
    <div className="stack">
      <div className="card stack">
        <Link to={`${base}/support`} className="small">← All cases</Link>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{c.ref}: {c.subject}</h2>
          <span className={`badge ${caseBadge[c.status]}`}>{STATUS_FOR_BUSINESS[c.status]}</span>
        </div>
        <div className="small muted">{c.categoryLabel} · opened {when(c.createdAt)} · replies go to {c.replyEmail}</div>
      </div>
      <Thread messages={c.messages} mine="business" />
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {action.error && <div className="error">{action.error}</div>}
        <label>{c.status === "resolved" ? "Still need help? Replying reopens the case." : "Add a reply"}
          <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={action.busy || !reply.trim()}>Send reply</button>
          {c.status !== "resolved" && <button type="button" disabled={action.busy} onClick={() => send(true)}>It's sorted, close the case</button>}
        </div>
      </form>
    </div>
  );
}
