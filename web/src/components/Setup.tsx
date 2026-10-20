import { useState, type ReactNode } from "react";

/** A read-only value (webhook URL, feed address) with a Copy button. */
export function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input readOnly value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }} />
      <button type="button" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

/** Numbered setup steps under a provider choice. */
export const Steps = ({ children }: { children: ReactNode }) => <ol className="small muted" style={{ margin: 0, paddingLeft: 20 }}>{children}</ol>;

/** Placeholder for a secret box: saved secrets are never sent back, only their last 4 characters; blank keeps the saved one. */
export const savedHint = (preview: string, placeholder: string) => (preview ? `${preview} saved` : placeholder);
