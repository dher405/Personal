import { useState } from "react";
import { api, money, toCents } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

const blank = { name: "", description: "", category: "", duration_min: 60, buffer_min: 0, price: "", deposit: "", active: true, staff_ids: [] as string[] };

export function Services() {
  const { biz } = useBusiness();
  const { data: services, reload } = useApi<any[]>(`/admin/${biz.id}/services`);
  const { data: staff } = useApi<any[]>(`/admin/${biz.id}/staff`);
  const [form, setForm] = useState<typeof blank & { id?: string }>(blank);
  const [open, setOpen] = useState(false);
  const action = useAction();

  const edit = (s: any) => {
    setForm({ ...s, price: (s.price_cents / 100).toFixed(2), deposit: s.deposit_cents ? (s.deposit_cents / 100).toFixed(2) : "", active: !!s.active });
    setOpen(true);
  };

  const save = () => action.run(async () => {
    const body = {
      name: form.name, description: form.description, category: form.category,
      duration_min: Number(form.duration_min), buffer_min: Number(form.buffer_min),
      price_cents: toCents(form.price), deposit_cents: toCents(form.deposit), active: form.active, staff_ids: form.staff_ids,
    };
    if (form.id) await api(`/admin/${biz.id}/services/${form.id}`, { method: "PATCH", body });
    else await api(`/admin/${biz.id}/services`, { body });
    setOpen(false); setForm(blank); reload();
  });

  return (
    <div className="stack">
      <div className="row"><div className="spacer" /><button className="primary" onClick={() => { setForm(blank); setOpen(true); }}>+ Add service</button></div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Service</th><th>Duration</th><th>Price</th><th>Staff</th><th>Status</th><th /></tr></thead>
          <tbody>
            {services?.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="small muted">{s.category}</div></td>
                <td>{s.duration_min} min{s.buffer_min ? <span className="small muted"> +{s.buffer_min} buffer</span> : null}</td>
                <td>{money(s.price_cents, biz.currency)}{s.deposit_cents ? <div className="small muted">deposit {money(s.deposit_cents, biz.currency)}</div> : null}</td>
                <td className="small">{s.staff_ids.map((id: string) => staff?.find((x) => x.id === id)?.name).filter(Boolean).join(", ") || <span className="badge warn">none</span>}</td>
                <td>{s.active ? <span className="badge ok">active</span> : <span className="badge">hidden</span>}</td>
                <td><button onClick={() => edit(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {services?.length === 0 && <p className="muted">No services yet.</p>}
      </div>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal stack" onClick={(e) => e.stopPropagation()}>
            <h2>{form.id ? "Edit service" : "New service"}</h2>
            {action.error && <div className="error">{action.error}</div>}
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>Description<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <div className="form-grid">
              <label>Category<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
              <label>Duration (min)<input type="number" min={5} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })} /></label>
              <label>Buffer after (min)<input type="number" min={0} value={form.buffer_min} onChange={(e) => setForm({ ...form, buffer_min: Number(e.target.value) })} /></label>
              <label>Price ({biz.currency})<input type="number" step="0.01" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
              <label>Deposit (optional)<input type="number" step="0.01" min={0} value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} /></label>
            </div>
            <div><div className="muted small">Who provides it</div>
              {staff?.map((s) => (
                <label key={s.id} className="inline">
                  <input type="checkbox" checked={form.staff_ids.includes(s.id)}
                    onChange={(e) => setForm({ ...form, staff_ids: e.target.checked ? [...form.staff_ids, s.id] : form.staff_ids.filter((x) => x !== s.id) })} />
                  {s.name}
                </label>
              ))}
            </div>
            <label className="inline"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Bookable</label>
            <div className="row"><button className="primary" disabled={action.busy || !form.name} onClick={save}>Save</button><button onClick={() => setOpen(false)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
