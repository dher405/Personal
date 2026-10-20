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
      <RepeatingSettings />
    </div>
  );
}

/** Repeating (weekly / fortnightly) bookings: customers can choose them on the booking page when this is on. */
function RepeatingSettings() {
  const { biz, reloadBiz } = useBusiness();
  const [weeks, setWeeks] = useState(String(biz.recurring_weeks ?? 26));
  const action = useAction();
  const patch = (body: Record<string, unknown>) => action.run(async () => { await api(`/admin/${biz.id}`, { method: "PATCH", body }); reloadBiz(); });
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 6 }}>
      <h3 style={{ margin: 0 }}>🔁 Repeating bookings</h3>
      {action.error && <div className="error">{action.error}</div>}
      <label className="inline">
        <input type="checkbox" checked={!!biz.allow_recurring} onChange={(e) => patch({ allow_recurring: e.target.checked })} />
        Let customers book the same time every week or every 2 weeks
      </label>
      <div className="row">
        <label>Book this many weeks at a time<input type="number" min={4} max={52} style={{ width: 100 }} value={weeks} onChange={(e) => setWeeks(e.target.value)} /></label>
        <button disabled={action.busy || Number(weeks) === biz.recurring_weeks} onClick={() => patch({ recurring_weeks: Number(weeks) })}>Save</button>
      </div>
      <p className="small muted">
        Each lesson is a normal booking you can move or cancel on its own. Weeks that are already taken are skipped and listed.
        Two weeks before the last lesson, the customer is emailed a one-click link to book the next {weeks || 26} weeks, and you're told too.
        {biz.require_payment ? " Because you take payment online, customers can't choose this themselves; you can still set it up from Bookings → + New booking." : ""}
        {" "}You can always set up repeating bookings yourself from Bookings → + New booking.
      </p>
    </div>
  );
}
