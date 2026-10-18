import { useState } from "react";
import { api } from "../../api";
import { useAction } from "../../hooks";
import { useBusiness } from "./AdminLayout";

const fields = [
  ["name", "Business name", "text"], ["category", "Category", "text"], ["phone", "Phone", "text"], ["address", "Address", "text"],
  ["timezone", "Timezone (IANA, e.g. America/Chicago)", "text"], ["currency", "Currency (e.g. USD)", "text"],
  ["slot_interval_min", "Start times every (min)", "number"], ["min_notice_min", "Minimum notice (min)", "number"],
  ["max_advance_days", "Book up to (days ahead)", "number"], ["cancellation_hours", "Online cancel/reschedule cutoff (hours)", "number"],
] as const;

export function Settings() {
  const { biz, reloadBiz } = useBusiness();
  const [form, setForm] = useState<Record<string, any>>(Object.fromEntries([...fields.map(([k]) => [k, biz[k] ?? ""]), ["description", biz.description]]));
  const [saved, setSaved] = useState(false);
  const action = useAction();

  const save = () => action.run(async () => {
    const body: Record<string, any> = {};
    for (const [k, , type] of fields) body[k] = type === "number" ? Number(form[k]) : form[k] || (k === "phone" || k === "address" ? null : form[k]);
    body.description = form.description;
    await api(`/admin/${biz.id}`, { method: "PATCH", body });
    reloadBiz(); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });

  return (
    <div className="card stack">
      {action.error && <div className="error">{action.error}</div>}
      <div className="form-grid">
        {fields.map(([k, label, type]) => (
          <label key={k}>{label}<input type={type} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
        ))}
      </div>
      <label>Description<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <p className="small muted">Booking link: <code>{window.location.origin}/b/{biz.slug}</code></p>
      <div className="row"><button className="primary" disabled={action.busy} onClick={save}>Save settings</button>{saved && <span className="notice small">Saved</span>}</div>
    </div>
  );
}
