import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";

/**
 * Super admin → Marketing: the agent that finds people asking for booking help and drafts replies.
 * It never posts: you review each draft, post it yourself, and the Posted log verifies what's live.
 */
export function Marketing() {
  const { data: o } = useApi<any>("/super/marketing/overview");
  const pending = o?.totals.pending ?? 0;
  return (
    <div className="stack">
      <nav className="tabs" style={{ marginTop: 0 }}>
        <NavLink end to="/super/marketing">Dashboard</NavLink>
        <NavLink to="/super/marketing/queue">{pending ? `Review queue (${pending})` : "Review queue"}</NavLink>
        <NavLink to="/super/marketing/posted">Posted log</NavLink>
        <NavLink to="/super/marketing/activity">Activity</NavLink>
        <NavLink to="/super/marketing/articles">Blog</NavLink>
        <NavLink to="/super/marketing/directories">Directories</NavLink>
        <NavLink to="/super/marketing/settings">Settings</NavLink>
      </nav>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="queue" element={<Queue />} />
        <Route path="posted" element={<Posted />} />
        <Route path="activity" element={<Activity />} />
        <Route path="articles" element={<Articles />} />
        <Route path="directories" element={<Directories />} />
        <Route path="settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

const when = (ts?: number | null) => (ts ? DateTime.fromSeconds(ts).toLocaleString(DateTime.DATETIME_SHORT) : "—");
const Ext = ({ href, children }: { href?: string | null; children: ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span className="muted">—</span>;
const LEVEL: Record<string, string> = { success: "ok", warn: "warn", error: "bad", info: "" };
const LIVE: Record<string, [string, string]> = {
  live: ["Live", "ok"], removed: ["Removed", "bad"], not_found: ["Not found yet", "warn"], unverified: ["Checking…", ""],
};

function Events({ events }: { events: any[] }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>When</th><th>Type</th><th>What happened</th><th>Link</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="small muted" style={{ whiteSpace: "nowrap" }}>{when(e.ts)}</td>
              <td><span className={`badge ${LEVEL[e.level] ?? ""}`}>{e.kind.replace("_", " ")}</span></td>
              <td className="small" style={{ wordBreak: "break-word" }}>{e.message}</td>
              <td className="small"><Ext href={e.url}>open ↗</Ext></td>
            </tr>
          ))}
          {!events.length && <tr><td colSpan={4} className="muted small">Nothing yet. Run a scan from the dashboard.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard() {
  const { data: o, reload } = useApi<any>("/super/marketing/overview");
  const action = useAction();
  // While a job runs, refresh every few seconds so progress shows up.
  useEffect(() => {
    if (!o?.running) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [o?.running]);
  if (!o) return <div className="muted">Loading…</div>;
  const t = o.totals;
  const runNow = (kind: string) => action.run(async () => { await api(`/super/marketing/run/${kind}`, { method: "POST" }); reload(); });

  return (
    <div className="stack">
      {!o.enabled && (
        <div className="card small">
          ⏸ The agent is <b>off</b>, so nothing runs on a schedule. You can still use <b>Run now</b> below to try it.
          Review the product description and sources, then switch it on under <Link to="/super/marketing/settings">Settings</Link>.
        </div>
      )}
      {!o.aiAvailable && <div className="error small">No Anthropic key. Add one under <Link to="/super/settings">Super admin → Settings</Link> (AI assistant or Marketing agent).</div>}
      {!o.redditReady && <div className="notice small" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>Reddit is turned on but has no app ID/secret. Add them under <Link to="/super/settings">Settings → Marketing agent</Link>, or turn Reddit off.</div>}
      {o.removed.length > 0 && (
        <div className="card" style={{ borderLeft: "3px solid var(--bad)" }}>
          <b style={{ color: "var(--bad)" }}>{o.removed.length === 1 ? "1 posted reply was" : `${o.removed.length} posted replies were`} removed by moderators.</b>{" "}
          <span className="small">Removals are the early warning before a ban; consider blocking that community in Settings.</span>
          <ul className="small">{o.removed.map((r: any) => <li key={r.id}>{r.community}: <Ext href={r.posted_url || r.thread_url}>{r.title}</Ext></li>)}</ul>
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        <Stat n={t.pending} label="awaiting your review" to="/super/marketing/queue" />
        <Stat n={t.posted} label={`posted (${t.postedWeek} this week)`} to="/super/marketing/posted" />
        <Stat n={t.live} label="verified live" tone="ok" />
        <Stat n={t.removed} label="removed" tone={t.removed ? "bad" : undefined} />
        <Stat n={`${Math.round(t.promoRatio * 100)}%`} label={`of recent posts mention ${o.productName} (limit ${Math.round(t.maxPromoRatio * 100)}%)`} />
        <Stat n={t.threads} label="threads evaluated" to="/super/marketing/activity" />
        <Stat n={t.articlesOnSite} label={`articles on your blog${t.articles ? ` (${t.articles} drafts waiting)` : ""}`} to="/super/marketing/articles" />
        <Stat n={`${t.directoriesLive}/${t.directoriesTotal}`} label={`directory listings live (${t.directoriesSubmitted} submitted)`} to="/super/marketing/directories" />
      </div>

      <h2 style={{ margin: "8px 0 0" }}>Jobs</h2>
      {action.error && <div className="error">{action.error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Job</th><th>Last run</th><th>Result</th><th>Next run</th><th></th></tr></thead>
          <tbody>
            {o.jobs.map((j: any) => (
              <tr key={j.kind}>
                <td>{j.label}</td>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{when(j.lastRun?.started_at)}</td>
                <td className="small">
                  {o.running === j.kind ? <span className="badge warn">running…</span>
                    : j.lastRun ? <><span className={`badge ${j.lastRun.status === "ok" ? "ok" : "bad"}`}>{j.lastRun.status}</span> {j.lastRun.summary}</>
                    : <span className="muted">never</span>}
                </td>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{j.nextDue ? when(j.nextDue) : <span className="muted">{o.enabled ? "not scheduled" : "agent off"}</span>}</td>
                <td><button disabled={!!o.running || action.busy} onClick={() => runNow(j.kind)}>Run now</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Recent activity</h2>
        <Link to="/super/marketing/activity" className="small">See all</Link>
      </div>
      <Events events={o.events} />
    </div>
  );
}

function Stat({ n, label, tone, to }: { n: ReactNode; label: string; tone?: string; to?: string }) {
  const body = <><div style={{ fontSize: "1.6rem", fontWeight: 700, color: tone ? `var(--${tone})` : undefined }}>{n}</div><div className="small muted">{label}</div></>;
  return <div className="card" style={{ marginBottom: 0, padding: 14 }}>{to ? <Link to={to} style={{ color: "inherit" }}>{body}</Link> : body}</div>;
}

function Activity() {
  const [kind, setKind] = useState("all");
  const [pages, setPages] = useState<any[][]>([]);
  const action = useAction();
  const load = (before?: number) => action.run(async () => {
    const rows = await api<any[]>(`/super/marketing/events?kind=${kind}${before ? `&before=${before}` : ""}`);
    setPages((p) => (before ? [...p, rows] : [rows]));
  });
  useEffect(() => { load(); }, [kind]);
  const events = pages.flat();
  const last = pages.at(-1);
  return (
    <div className="stack">
      <div className="row small">
        Show:
        {["all", "drafted", "posted", "verified", "removed", "not_found", "irrelevant", "skipped", "article", "error"].map((k) => (
          <button key={k} className={k === kind ? "primary" : ""} onClick={() => setKind(k)}>{k.replace("_", " ")}</button>
        ))}
      </div>
      {action.error && <div className="error">{action.error}</div>}
      <Events events={events} />
      {last?.length === 100 && <button disabled={action.busy} onClick={() => load(events.at(-1).id)}>Older</button>}
    </div>
  );
}

function Queue() {
  const { data, reload } = useApi<any[]>("/super/marketing/drafts");
  if (!data) return <div className="muted">Loading…</div>;
  if (!data.length) return <div className="card muted">Nothing to review. Run a scan from the <Link to="/super/marketing">dashboard</Link>.</div>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Edit if you like, press <b>Copy &amp; open thread</b>, paste and post it under your own account, then click <b>I posted it</b>.
        The Posted log then finds your comment and links straight to it.
      </p>
      {data.map((d) => <DraftCard key={d.id} d={d} onDone={reload} />)}
    </div>
  );
}

function DraftCard({ d, onDone }: { d: any; onDone: () => void }) {
  const [reply, setReply] = useState(d.reply);
  const [postedUrl, setPostedUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const decide = (act: "posted" | "skipped") => action.run(async () => {
    await api(`/super/marketing/drafts/${d.id}`, { body: { action: act, reply, postedUrl } });
    onDone();
  });
  const copyAndOpen = async () => {
    try { await navigator.clipboard.writeText(reply); setCopied(true); } catch { /* clipboard blocked: the text is still selectable */ }
    window.open(d.thread_url, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="card stack">
      <div className="row small muted" style={{ justifyContent: "space-between" }}>
        <span>{d.community} · posted {when(d.thread_created_at)}</span>
        <span className="row" style={{ gap: 6 }}>
          <span className="badge">{d.relevance}/10</span>
          <span className={`badge ${d.mentions_product ? "warn" : "ok"}`}>{d.mentions_product ? "mentions product" : "pure help"}</span>
        </span>
      </div>
      <h3 style={{ margin: 0 }}><Ext href={d.thread_url}>{d.title}</Ext></h3>
      <div className="small muted">{d.reason}</div>
      {d.rules_risk && d.rules_risk.toLowerCase() !== "none" && <div className="small" style={{ color: "var(--warn)" }}>⚠ Rules: {d.rules_risk}</div>}
      <details><summary className="small muted">Original post</summary><p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.thread_body?.slice(0, 3000) || "(no text)"}</p></details>
      <textarea rows={7} value={reply} onChange={(e) => setReply(e.target.value)} />
      <input value={postedUrl} onChange={(e) => setPostedUrl(e.target.value)} placeholder="Optional: link to your comment once posted (otherwise it's found automatically)" />
      {action.error && <div className="error">{action.error}</div>}
      <div className="row">
        <button onClick={copyAndOpen}>{copied ? "Copied ✓ Open thread again" : "Copy & open thread"}</button>
        <button className="primary" disabled={action.busy} onClick={() => decide("posted")}>I posted it</button>
        <button disabled={action.busy} onClick={() => decide("skipped")}>Skip</button>
      </div>
    </div>
  );
}

function Posted() {
  const { data, reload } = useApi<any[]>("/super/marketing/posted");
  useEffect(() => {
    if (!data?.some((d) => d.live_status === "unverified")) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [data]);
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Every reply you marked as posted. The agent finds your actual comment, links straight to it, compares the live text with what you
        approved, and rechecks every 6 hours for 30 days to catch moderator removals.
      </p>
      {!data.length && <div className="card muted">No posted replies yet.</div>}
      {data.map((d) => <PostedCard key={d.id} d={d} onSaved={reload} />)}
    </div>
  );
}

function PostedCard({ d, onSaved }: { d: any; onSaved: () => void }) {
  const [link, setLink] = useState(d.posted_url ?? "");
  const action = useAction();
  const [label, tone] = LIVE[d.live_status] ?? [d.live_status, ""];
  const save = () => action.run(async () => { await api(`/super/marketing/posted/${d.id}/link`, { body: { postedUrl: link } }); onSaved(); });
  return (
    <div className="card stack" style={d.live_status === "removed" ? { borderLeft: "3px solid var(--bad)" } : undefined}>
      <div className="row small muted" style={{ justifyContent: "space-between" }}>
        <span className={`badge ${tone}`}>{label}</span>
        <span>{d.community} · posted {when(d.decided_at)} · checked {when(d.last_checked)}{d.live_score != null ? ` · score ${d.live_score}` : ""}</span>
      </div>
      <h3 style={{ margin: 0 }}><Ext href={d.thread_url}>{d.title}</Ext></h3>
      <div className="small">
        <b>Your reply: </b>
        {d.posted_url ? <Ext href={d.posted_url}>{d.posted_url}</Ext> : <span className="muted">not located yet</span>}
        {d.match != null && <span className={d.match < 70 ? "" : "muted"} style={d.match < 70 ? { color: "var(--warn)" } : undefined}> · live text {d.match}% match to the approved draft</span>}
      </div>
      <details>
        <summary className="small muted">Approved text vs. what's on the page</summary>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 8 }}>
          <div><div className="small muted">Approved</div><p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.reply}</p></div>
          <div><div className="small muted">Live</div><p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.live_text || "(not fetched yet)"}</p></div>
        </div>
      </details>
      <div className="row">
        <input style={{ flex: 1, minWidth: 220 }} value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste the direct link to your comment" />
        <button disabled={action.busy} onClick={save}>Save link &amp; recheck</button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
    </div>
  );
}

function Articles() {
  const { data, reload } = useApi<any[]>("/super/marketing/articles");
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Read and fact-check each draft, edit anything you like, then <b>Publish on my site</b> to put it live at <a href="/blog" target="_blank" rel="noreferrer">/blog</a>,
        listed in your sitemap for search engines. You can unpublish or edit it any time.
      </p>
      {!data.length && <div className="card muted">No blog drafts yet. Use "Write a blog draft" on the dashboard (it needs at least one scan first).</div>}
      {data.map((a) => <ArticleCard key={a.id} a={a} onSaved={reload} />)}
    </div>
  );
}

const ARTICLE_STATUS: Record<string, [string, string]> = { draft: ["Draft", ""], published: ["Published", "ok"], rejected: ["Rejected", "bad"] };

function ArticleCard({ a, onSaved }: { a: any; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(a.title);
  const [description, setDescription] = useState(a.description ?? "");
  const [body, setBody] = useState(a.body);
  const [preview, setPreview] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState(a.on_site ? "" : a.published_url ?? "");
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const dirty = title !== a.title || description !== (a.description ?? "") || body !== a.body;
  const [label, tone] = ARTICLE_STATUS[a.status] ?? [a.status, ""];

  const save = () => action.run(async () => { await api(`/super/marketing/articles/${a.id}`, { method: "PATCH", body: { title, description, body } }); onSaved(); });
  const status = (act: string) => action.run(async () => {
    if (dirty) await api(`/super/marketing/articles/${a.id}`, { method: "PATCH", body: { title, description, body } });
    await api(`/super/marketing/articles/${a.id}/status`, { body: { action: act, publishedUrl: act === "publish_external" ? externalUrl : undefined } });
    onSaved();
  });
  const showPreview = () => action.run(async () => setPreview((await api<{ html: string }>("/super/marketing/articles/preview", { body: { body } })).html));

  return (
    <div className="card stack">
      <div className="row small muted" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 6 }}>
          <span className={`badge ${tone}`}>{label}</span>
          {a.status === "published" && <span className="badge">{a.on_site ? "on your site" : "elsewhere"}</span>}
        </span>
        <span>written {when(a.created_at)}{a.published_at ? ` · published ${when(a.published_at)}` : ""}</span>
      </div>
      <h3 style={{ margin: 0 }}>{a.title}</h3>
      {a.published_url && <div className="small"><b>Live at: </b><Ext href={a.published_url}>{a.published_url}</Ext></div>}
      {description && !editing && <div className="small muted">{description}</div>}

      {editing ? (
        <div className="stack">
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>Search description<input value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            <span className="small muted">{description.length}/155 shown in Google results</span></label>
          <label>Article (Markdown)<textarea rows={18} value={body} onChange={(e) => { setBody(e.target.value); setPreview(null); }} style={{ fontFamily: "ui-monospace, monospace", fontSize: ".85rem" }} /></label>
        </div>
      ) : (
        <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && preview === null) showPreview(); }}>
          <summary className="small muted">Read it as it will appear</summary>
          {preview === null ? <div className="small muted">Loading…</div> : <div className="small" style={{ lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: preview }} />}
        </details>
      )}
      {editing && preview !== null && <div className="card small" style={{ lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: preview }} />}

      {action.error && <div className="error">{action.error}</div>}
      <div className="row">
        {editing ? (
          <>
            <button className="primary" disabled={!dirty || action.busy} onClick={save}>Save changes</button>
            <button disabled={action.busy} onClick={showPreview}>Preview</button>
            <button onClick={() => { setEditing(false); setTitle(a.title); setDescription(a.description ?? ""); setBody(a.body); setPreview(null); }}>Done</button>
          </>
        ) : <button onClick={() => { setEditing(true); setPreview(null); }}>Edit</button>}
        {a.status === "published" && a.on_site
          ? <button disabled={action.busy} onClick={() => confirm("Take this article off your site?") && status("unpublish")}>Unpublish</button>
          : <button className="primary" disabled={action.busy} onClick={() => status("publish_site")}>{dirty ? "Save & publish on my site" : "Publish on my site"}</button>}
        <button onClick={async () => { await navigator.clipboard.writeText(body).catch(() => {}); setCopied(true); }}>{copied ? "Copied ✓" : "Copy Markdown"}</button>
        {a.status !== "rejected" && !(a.status === "published" && a.on_site) && <button disabled={action.busy} onClick={() => status("reject")}>Reject</button>}
      </div>
      {!(a.status === "published" && a.on_site) && (
        <details>
          <summary className="small muted">Published it somewhere else instead?</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ flex: 1, minWidth: 220 }} value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://… where you published it" />
            <button disabled={action.busy || !externalUrl} onClick={() => status("publish_external")}>Mark published there</button>
          </div>
        </details>
      )}
    </div>
  );
}

// ---------- Directory kit ----------

const DIR_STATUS: Record<string, [string, string]> = {
  todo: ["To do", ""], drafting: ["Writing…", "warn"], ready: ["Copy ready", ""], submitted: ["Submitted", "warn"], live: ["Live", "ok"], skipped: ["Skipped", ""],
};

function Directories() {
  const { data, reload } = useApi<any[]>("/super/marketing/directories");
  useEffect(() => {
    if (!data?.some((d) => d.status === "drafting")) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [data]);
  if (!data) return <div className="muted">Loading…</div>;
  const live = data.filter((d) => d.status === "live").length;
  const submitted = data.filter((d) => ["submitted", "live"].includes(d.status)).length;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Free listings where people shopping for booking software look. For each one: <b>Write listing copy</b>, sign up on the site,
        paste the copy in with the Copy buttons, then mark it <b>Submitted</b> with your listing's link, and <b>Live</b> once it's approved.
        {" "}{submitted} of {data.length} submitted · {live} live.
      </p>
      {data.map((d) => <DirectoryCard key={d.id} d={d} onChanged={reload} />)}
    </div>
  );
}

function DirectoryCard({ d, onChanged }: { d: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<Record<string, string> | null>(d.copy);
  const [url, setUrl] = useState(d.listingUrl ?? "");
  const [notes, setNotes] = useState(d.notes ?? "");
  const [instruction, setInstruction] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => { setCopy(d.copy); }, [d.updatedAt]);
  const [label, tone] = DIR_STATUS[d.status] ?? [d.status, ""];
  const copyDirty = JSON.stringify(copy) !== JSON.stringify(d.copy);

  const write = () => action.run(async () => { await api(`/super/marketing/directories/${d.id}/write`, { body: { instruction: instruction || undefined } }); setInstruction(""); setOpen(true); onChanged(); });
  const patch = (body: object) => action.run(async () => { await api(`/super/marketing/directories/${d.id}`, { method: "PATCH", body }); onChanged(); });
  const copyField = async (key: string, text: string) => { await navigator.clipboard.writeText(text).catch(() => {}); setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1500); };

  return (
    <div className="card stack" style={d.status === "live" ? { borderLeft: "3px solid var(--ok)" } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}><Ext href={d.url}>{d.name}</Ext></h3>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <div className="small">{d.why}</div>
      <div className="small muted"><b>How:</b> {d.howTo}</div>
      {d.listingUrl && <div className="small"><b>Your listing: </b><Ext href={d.listingUrl}>{d.listingUrl}</Ext>{d.submittedAt ? <span className="muted"> · submitted {when(d.submittedAt)}</span> : null}</div>}
      {d.error && <div className="error small">{d.error}</div>}
      {action.error && <div className="error">{action.error}</div>}

      <div className="row">
        {d.status === "drafting" ? <span className="small muted">The agent is writing this listing…</span> : (
          <>
            <button className={copy ? "" : "primary"} disabled={action.busy} onClick={write}>{copy ? "Rewrite copy" : "Write listing copy"}</button>
            {copy && <button onClick={() => setOpen(!open)}>{open ? "Hide copy" : "Show copy"}</button>}
          </>
        )}
        {copy && d.status !== "drafting" && <input style={{ flex: 1, minWidth: 200 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional instruction for a rewrite, e.g. focus on music teachers" />}
      </div>

      {open && copy && (
        <div className="stack">
          {d.fields.map((f: any) => {
            const value = copy[f.key] ?? "";
            return (
              <label key={f.key}>
                <span className="row" style={{ justifyContent: "space-between" }}>
                  <span>{f.label} <span className="small muted">· {value.length}{f.aim ? ` / aim ~${f.aim}` : ""} characters</span></span>
                  <button type="button" className="small" onClick={() => copyField(f.key, value)}>{copiedKey === f.key ? "Copied ✓" : "Copy"}</button>
                </span>
                <textarea rows={Math.min(14, Math.max(2, Math.ceil(value.length / 90) + value.split("\n").length - 1))} value={value}
                  onChange={(e) => setCopy({ ...copy, [f.key]: e.target.value })} />
                <span className="small muted">{f.help}</span>
              </label>
            );
          })}
          {copyDirty && <div><button className="primary" disabled={action.busy} onClick={() => patch({ copy })}>Save my edits</button></div>}
        </div>
      )}

      <details>
        <summary className="small muted">Track this listing</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to your listing (or your vendor dashboard)" />
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes: login email, review status, follow-ups…" />
          <div className="row">
            <button disabled={action.busy} onClick={() => patch({ status: "submitted", listingUrl: url, notes })}>Mark submitted</button>
            <button className="primary" disabled={action.busy} onClick={() => patch({ status: "live", listingUrl: url, notes })}>Mark live</button>
            <button disabled={action.busy} onClick={() => patch({ listingUrl: url, notes })}>Save</button>
            {d.status !== "skipped"
              ? <button disabled={action.busy} onClick={() => patch({ status: "skipped", notes })}>Skip this one</button>
              : <button disabled={action.busy} onClick={() => patch({ status: copy ? "ready" : "todo" })}>Undo skip</button>}
          </div>
        </div>
      </details>
    </div>
  );
}

// ---------- Settings ----------

const fromLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** A one-item-per-line box. Keeps the text as typed (blank lines while editing), saving only the non-empty lines. */
function ListField({ label, help, initial, onChange }: { label: string; help?: string; initial: string[]; onChange: (xs: string[]) => void }) {
  const [text, setText] = useState(initial.join("\n"));
  return (
    <label style={{ gridColumn: "1 / -1" }}>{label}
      <textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); onChange(fromLines(e.target.value)); }} />
      <span className="small muted">{help ?? "One per line"}</span>
    </label>
  );
}

function Settings() {
  const { data, setData } = useApi<any>("/super/marketing/settings");
  const [s, setS] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  useEffect(() => { if (data) setS(structuredClone(data.settings)); }, [data]);
  if (!data || !s) return <div className="muted">Loading…</div>;
  const set = (path: string, value: unknown) => setS((prev: any) => {
    const next = structuredClone(prev);
    const keys = path.split(".");
    let obj = next;
    for (const k of keys.slice(0, -1)) obj = obj[k];
    obj[keys.at(-1)!] = value;
    return next;
  });
  const save = () => action.run(async () => {
    const res = await api("/super/marketing/settings", { method: "PUT", body: s });
    setData({ ...data, settings: res.settings }); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });
  const text = (path: string, label: string, help?: string) => (
    <label>{label}<input value={path.split(".").reduce((o, k) => o[k], s)} onChange={(e) => set(path, e.target.value)} />{help && <span className="small muted">{help}</span>}</label>
  );
  const list = (path: string, label: string, help?: string) => (
    <ListField key={path} label={label} help={help} initial={path.split(".").reduce((o, k) => o[k], s)} onChange={(xs) => set(path, xs)} />
  );
  const num = (path: string, label: string, help?: string, step = 1) => (
    <label>{label}<input type="number" step={step} value={path.split(".").reduce((o, k) => o[k], s)} onChange={(e) => set(path, Number(e.target.value))} />{help && <span className="small muted">{help}</span>}</label>
  );
  const check = (path: string, label: string) => (
    <label className="inline"><input type="checkbox" checked={path.split(".").reduce((o, k) => o[k], s)} onChange={(e) => set(path, e.target.checked)} />{label}</label>
  );
  const seIds = Object.entries(s.accounts.stackexchangeUserIds).map(([k, v]) => `${k}=${v}`).join("\n");

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Agent</h2>
        {check("enabled", "On: scan, verify and write blog drafts on the schedule below")}
        <p className="small muted" style={{ margin: 0 }}>
          The agent only reads Reddit, Hacker News and Stack Exchange. It never posts: every reply waits in the Review queue for you.
          Anthropic key: {data.aiAvailable ? "✅ set" : "❌ missing"} · Reddit app: {data.redditConfigured ? "✅ set" : "not set"} (both under <Link to="/super/settings">Super admin → Settings</Link>).
        </p>
        <div className="form-grid">
          {num("schedule.scanEveryHours", "Scan every (hours)", "0 = only when you click Run now")}
          {num("schedule.verifyEveryHours", "Verify posted replies every (hours)")}
          {num("schedule.blogEveryDays", "Write a blog draft every (days)")}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Product</h2>
        <p className="small muted" style={{ margin: 0 }}>The agent only claims what's written here, so keep it accurate.</p>
        <div className="form-grid">
          {text("product.name", "Name")}
          {text("product.url", "Website")}
          <label style={{ gridColumn: "1 / -1" }}>Description<textarea rows={4} value={s.product.description} onChange={(e) => set("product.description", e.target.value)} /></label>
          {list("product.features", "Key features")}
          {list("product.idealCustomers", "Ideal customers")}
          {list("product.notAGoodFitFor", "Not a good fit for", "Honest limits stop it recommending Slotwise where it doesn't fit")}
          {text("product.pricing", "Pricing line (optional)", "Leave blank and pricing is never mentioned")}
          {text("product.disclosure", "Disclosure line", "Added whenever a reply mentions the product; many communities require it")}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Where to look</h2>
        <div className="form-grid">
          {list("search.queries", "Search phrases")}
          {check("sources.hackernews", "Hacker News")}
          {check("sources.stackexchange", "Stack Exchange")}
          {check("sources.reddit", "Reddit (needs the app ID/secret in Settings)")}
          {list("sources.subreddits", "Subreddits", "One per line, without r/")}
          {list("sources.stackexchangeSites", "Stack Exchange sites", "One per line, e.g. webapps, softwarerecs")}
          {num("search.maxThreadAgeDays", "Ignore threads older than (days)")}
          {num("search.maxCandidatesPerRun", "Max new threads per scan", "Caps the AI cost of each scan")}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Your accounts</h2>
        <p className="small muted" style={{ margin: 0 }}>Used to find what you posted and link straight to it.</p>
        <div className="form-grid">
          {text("accounts.redditUsername", "Reddit username", "Without u/")}
          {text("accounts.hnUsername", "Hacker News username")}
          <label style={{ gridColumn: "1 / -1" }}>Stack Exchange user IDs
            <textarea rows={3} defaultValue={seIds} onChange={(e) => set("accounts.stackexchangeUserIds", Object.fromEntries(
              fromLines(e.target.value).map((l) => l.split("=").map((x) => x.trim())).filter(([k, v]) => k && /^\d+$/.test(v ?? "")).map(([k, v]) => [k, Number(v)]),
            ))} />
            <span className="small muted">One per line as site=id, e.g. webapps=123456 (the number in your profile URL on that site)</span>
          </label>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Limits</h2>
        <div className="form-grid">
          {num("guardrails.maxDraftsPerCommunityPerWeek", "Max drafts per community per week")}
          {num("guardrails.maxPendingDrafts", "Stop drafting when the queue has")}
          {num("guardrails.maxPromoRatio", "Max share of recent posts that mention the product", "0.3 = 30%. Above it, new drafts are pure help", 0.05)}
          {num("guardrails.promoWindow", "…counted over your last N posts")}
          {num("ai.minRelevance", "Minimum relevance to draft (0-10)")}
          <label>AI effort
            <select value={s.ai.effort} onChange={(e) => set("ai.effort", e.target.value)}>{["low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}</select>
          </label>
          {text("ai.model", "Model")}
          {list("guardrails.blockedCommunities", "Blocked communities", "One per line, as shown in the queue, e.g. reddit:startups")}
          {text("blog.audience", "Blog audience")}
        </div>
      </div>

      {action.error && <div className="error">{action.error}</div>}
      <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--bg)", padding: "10px 0" }}>
        <button className="primary" disabled={action.busy}>Save marketing settings</button>
        {saved && <span className="notice small">Saved</span>}
      </div>
    </form>
  );
}
