import { useState } from "react";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";

const SOURCE: Record<string, [string, string]> = {
  settings: ["Saved here", "ok"],
  environment: ["From Render environment", ""],
  unset: ["Not set", "warn"],
};

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input readOnly value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }} />
      <button type="button" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** Super admin → Settings: every integration's keys and the webhook addresses to give each provider. */
export function PlatformSettings() {
  const { data, setData } = useApi<any>("/super/settings");
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Integrations</h2>
        <p className="small muted">
          Paste each service's keys here and they take effect immediately; no redeploy is needed. Secret keys are stored encrypted and
          only their last 4 characters are ever shown. A value saved here overrides the same setting in your Render environment.
        </p>
        {!data.encryptionKeySet && <div className="error small">APP_ENCRYPTION_KEY isn't set on the server, so a development key is being used. Set it in Render before saving real keys.</div>}
        <div className="notice small" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
          Settings are saved in the database. On Render's free plan the database is erased on every restart or deploy, so keys saved here would be lost. Add a persistent disk (Starter plan) before relying on this page.
        </div>
      </div>
      {data.groups.map((g: any) => <Group key={g.id} group={g} onSaved={(groups) => setData({ ...data, groups })} />)}
    </div>
  );
}

function Group({ group: g, onSaved }: { group: any; onSaved: (groups: any[]) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const dirty = Object.keys(values).length > 0;

  const save = (override?: Record<string, string | null>) => action.run(async () => {
    const res = await api("/super/settings", { method: "PUT", body: { values: override ?? values } });
    onSaved(res.groups);
    setValues({}); setResult(null); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });
  const test = () => action.run(async () => setResult(await api(`/super/settings/test/${g.id}`, { method: "POST" })));

  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <h2 style={{ margin: 0 }}>{g.title}</h2>
      <p className="small muted" style={{ margin: 0 }}>{g.description}</p>
      {g.urls.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {g.urls.map((u: any) => <label key={u.url}>{u.label}<Copy value={u.url} /></label>)}
        </div>
      )}
      <div className="form-grid">
        {g.fields.map((f: any) => {
          const [srcLabel, srcTone] = SOURCE[f.source];
          const label = (
            <span className="row" style={{ gap: 6 }}>
              {f.label} <span className={`badge ${srcTone}`}>{srcLabel}</span>
            </span>
          );
          const current = values[f.name] ?? (f.secret ? "" : f.value);
          const set = (v: string) => setValues({ ...values, [f.name]: v });
          return (
            <label key={f.name} style={f.multiline ? { gridColumn: "1 / -1" } : undefined}>
              {label}
              {f.options ? (
                <select value={current} onChange={(e) => set(e.target.value)}>
                  <option value="">(default)</option>
                  {f.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.multiline ? (
                <textarea rows={4} value={current} onChange={(e) => set(e.target.value)} placeholder={f.preview ? `${f.preview} saved. Paste a new key to replace it.` : f.placeholder} />
              ) : (
                <input type={f.secret ? "password" : "text"} autoComplete="off" value={current} onChange={(e) => set(e.target.value)}
                  placeholder={f.preview ? `${f.preview} saved` : f.placeholder ?? ""} />
              )}
              {f.help && <span className="small muted">{f.help}</span>}
              {f.source === "settings" && (
                <button type="button" className="link small" style={{ alignSelf: "flex-start" }}
                  onClick={() => confirm(`Remove the saved ${f.label}?`) && save({ [f.name]: null })}>Remove saved value</button>
              )}
            </label>
          );
        })}
      </div>
      {action.error && <div className="error">{action.error}</div>}
      {result && <div className={result.ok ? "notice" : "error"}>{result.message}</div>}
      <div className="row">
        <button className="primary" disabled={!dirty || action.busy}>Save {g.title}</button>
        {g.testable && <button type="button" disabled={action.busy || dirty} onClick={test} title={dirty ? "Save first" : ""}>Test connection</button>}
        {saved && <span className="notice small">Saved</span>}
      </div>
    </form>
  );
}
