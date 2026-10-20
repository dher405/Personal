import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { caseBadge, Thread, when } from "../admin/Support";

const STATUS_LABEL: Record<string, string> = { open: "Needs reply", waiting: "Waiting on business", resolved: "Resolved" };

/** Super admin → Support: every business's cases, the conversation on each, and who's notified. */
export function SupportDesk() {
  return (
    <div className="stack">
      <nav className="tabs" style={{ marginTop: 0 }}>
        <NavLink end to="/super/support">Cases</NavLink>
        <NavLink to="/super/support/issues">Issues found</NavLink>
      </nav>
      <Routes>
        <Route index element={<CaseList />} />
        <Route path="issues" element={<Issues />} />
        <Route path=":cid" element={<CaseDetail />} />
      </Routes>
    </div>
  );
}

const SEVERITY_BADGE: Record<string, string> = { urgent: "bad", high: "bad", medium: "warn", low: "" };
const KIND_LABEL: Record<string, string> = { bug: "Bug", process: "Process", docs: "Guide/docs", feature_request: "Feature request", setup: "Setup trap" };
const ISSUE_STATUS: Record<string, string> = { new: "New", investigating: "Investigating", fixed: "Fixed", wont_fix: "Won't fix" };

/** The support assistant's work on a case: findings, a draft for approval, and re-runs with instructions. */
function AssistantPanel({ c, reload }: { c: any; reload: () => void }) {
  const t = c.triage;
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState("waiting");
  const [instruction, setInstruction] = useState("");
  const action = useAction();
  // While the assistant is working, check back every few seconds.
  useEffect(() => {
    if (t?.status !== "running") return;
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, [t?.status, t?.id]);
  useEffect(() => { setDraft(null); }, [t?.id]);

  if (!c.aiAvailable) {
    return <div className="card small muted">🤖 The support assistant can investigate cases and draft replies for you. Add an Anthropic key under <Link to="/super/settings">Settings → Support assistant</Link>.</div>;
  }
  const rerun = (text?: string) => action.run(async () => { await api(`/super/support/${c.id}/triage`, { body: { instruction: text || undefined } }); setInstruction(""); reload(); });
  const text = draft ?? t?.draft_reply ?? "";

  return (
    <div className="card stack" style={{ borderLeft: "3px solid var(--lp-coral, var(--accent))" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>🤖 Support assistant</h3>
        {t?.status === "done" && <span className="row" style={{ gap: 6 }}>
          <span className="badge">{String(t.category).replace("_", " ")}</span>
          <span className={`badge ${SEVERITY_BADGE[t.severity] ?? ""}`}>{t.severity}</span>
        </span>}
      </div>
      {action.error && <div className="error">{action.error}</div>}
      {!t && <div className="row"><span className="muted small">Not analysed yet.</span><button className="primary" disabled={action.busy} onClick={() => rerun()}>Analyse this case</button></div>}
      {t?.status === "running" && <div className="muted">Investigating: reading the case and checking the business's setup and logs…</div>}
      {t?.status === "failed" && <div className="error">The assistant couldn't finish: {t.error} <button className="small" onClick={() => rerun()}>Try again</button></div>}
      {t?.status === "done" && (
        <>
          <div><b>Summary.</b> {t.summary}</div>
          <div><b>Likely cause.</b> {t.likely_cause}</div>
          <details><summary className="small">Notes for you</summary><div className="small" style={{ whiteSpace: "pre-wrap" }}>{t.internal_notes}</div></details>
          {c.issues.length > 0 && <div className="small">Issues flagged: {c.issues.map((i: any) => <Link key={i.id} to="/super/support/issues" style={{ marginRight: 8 }}>#{i.number} {i.title}</Link>)}</div>}
          {t.draft_status === "pending" ? (
            <div className="stack">
              <label>Draft reply to {c.businessName} (not sent; edit it, then approve)
                <textarea rows={8} value={text} onChange={(e) => setDraft(e.target.value)} />
              </label>
              <div className="row">
                <label>After sending, mark as
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="waiting">Waiting on business</option><option value="resolved">Resolved</option><option value="open">Needs reply</option>
                  </select>
                </label>
                <button className="primary" disabled={action.busy || !text.trim()} onClick={() => confirm(`Send this reply to ${c.businessName}?`) && action.run(async () => {
                  await api(`/super/support/${c.id}/draft/send`, { body: { body: text, status } }); reload();
                })}>Approve and send</button>
                <button disabled={action.busy} onClick={() => action.run(async () => { await api(`/super/support/${c.id}/draft/discard`, { method: "POST" }); reload(); })}>Discard draft</button>
              </div>
            </div>
          ) : (
            <div className="small muted">Draft {t.draft_status === "sent" ? "approved and sent" : "discarded"}.</div>
          )}
        </>
      )}
      {t && t.status !== "running" && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); rerun(instruction); }}>
          <input style={{ flex: 1, minWidth: 220 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder='Ask it to look again: "check their email log", "make the reply shorter"…' />
          <button disabled={action.busy}>{instruction.trim() ? "Ask" : "Re-analyse"}</button>
        </form>
      )}
    </div>
  );
}

/** Bugs and process issues the assistant found, grouped across cases, ready to hand to a developer. */
function Issues() {
  const [filter, setFilter] = useState("open");
  const { data, reload } = useApi<any[]>(`/super/support/issues?status=${filter}`);
  const [copied, setCopied] = useState("");
  const action = useAction();
  const copy = (i: any) => action.run(async () => {
    const { report } = await api(`/super/support/issues/${i.id}/report`);
    await navigator.clipboard?.writeText(report);
    setCopied(i.id); setTimeout(() => setCopied(""), 2000);
  });
  return (
    <div className="stack">
      <div className="card row">
        {[["open", "Open"], ["fixed", "Fixed"], ["wont_fix", "Won't fix"], ["all", "All"]].map(([v, l]) => (
          <button key={v} className={filter === v ? "primary" : ""} onClick={() => setFilter(v)}>{l}</button>
        ))}
        <span className="small muted">Found by the support assistant across cases. <b>Copy for Claude Code</b> gives a full bug report to paste into a Claude Code session to fix it.</span>
      </div>
      {action.error && <div className="error">{action.error}</div>}
      {data?.map((i) => (
        <div key={i.id} className="card stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>#{i.number} {i.title}</h3>
            <span className="row" style={{ gap: 6 }}><span className="badge">{KIND_LABEL[i.kind]}</span><span className="badge">{i.case_count} case{i.case_count === 1 ? "" : "s"}</span></span>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{i.details}</div>
          {i.suggested_fix && <div className="small"><b>Suggested fix:</b> {i.suggested_fix}</div>}
          <div className="small">Cases: {i.cases.map((c: any) => <Link key={c.id} to={`/super/support/${c.id}`} style={{ marginRight: 8 }}>{c.ref}</Link>)}</div>
          <div className="row">
            <select style={{ width: "auto" }} value={i.status} onChange={(e) => action.run(async () => { await api(`/super/support/issues/${i.id}`, { method: "PATCH", body: { status: e.target.value } }); reload(); })}>
              {Object.entries(ISSUE_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button onClick={() => copy(i)}>{copied === i.id ? "Copied" : "Copy for Claude Code"}</button>
          </div>
        </div>
      ))}
      {data?.length === 0 && <p className="muted">No issues here.</p>}
    </div>
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
                <td><Link to={`/super/support/${c.id}`}>{c.subject}</Link><div className="small muted">{c.categoryLabel} · {c.messageCount} message{c.messageCount === 1 ? "" : "s"}</div>
                  {c.triage?.status === "running" && <div className="small muted">🤖 analysing…</div>}
                  {c.triage?.status === "done" && <div className="small">🤖 <span className={`badge ${SEVERITY_BADGE[c.triage.severity] ?? ""}`}>{c.triage.severity}</span> {String(c.triage.category).replace("_", " ")}{c.triage.draftPending ? <b> · draft ready</b> : ""}</div>}
                </td>
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
      <AssistantPanel c={c} reload={reload} />
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
    await api("/super/support/settings", { method: "PUT", body: { notifyEmails, onNewCase: f.onNewCase, onBusinessReply: f.onBusinessReply, onSupportReply: f.onSupportReply, aiAutoTriage: f.aiAutoTriage, aiInstructions: f.aiInstructions } });
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
      <h3 style={{ margin: "8px 0 0" }}>🤖 Support assistant</h3>
      {!data.aiAvailable
        ? <p className="small muted" style={{ margin: 0 }}>Add an Anthropic API key and model under <Link to="/super/settings">Settings → Support assistant</Link> to switch it on.</p>
        : <p className="small muted" style={{ margin: 0 }}>Using {data.aiModel}. It reads each case, checks the business's setup and logs (read-only), drafts a reply for you to approve, and records bugs and process issues under Issues found. It never sends anything itself.</p>}
      <label className="inline"><input type="checkbox" checked={f.aiAutoTriage} onChange={(e) => setF({ ...f, aiAutoTriage: e.target.checked })} /> Analyse new cases and business replies automatically</label>
      <label>Instructions for the assistant (optional)
        <textarea rows={3} value={f.aiInstructions} onChange={(e) => setF({ ...f, aiInstructions: e.target.value })}
          placeholder="e.g. Always check the email log first. We give one month's credit for outages over an hour, but leave offers to me." />
      </label>
      {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
      {action.error && <div className="error">{action.error}</div>}
      <div className="row">
        <button className="primary" disabled={action.busy}>Save notifications</button>
        <button type="button" disabled={action.busy} onClick={test}>Send a test email</button>
      </div>
    </form>
  );
}
