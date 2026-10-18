import { useState } from "react";
import { DateTime } from "luxon";
import { api } from "../../api";
import { useAction, useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
type Block = { weekday: number; start_time: string; end_time: string };

export function Staff() {
  const { biz } = useBusiness();
  const { data: staff, reload } = useApi<any[]>(`/admin/${biz.id}/staff`);
  const [name, setName] = useState("");
  const action = useAction();

  return (
    <div className="stack">
      {action.error && <div className="error">{action.error}</div>}
      <form className="card row" onSubmit={(e) => { e.preventDefault(); action.run(async () => { await api(`/admin/${biz.id}/staff`, { body: { name } }); setName(""); reload(); }); }}>
        <input style={{ flex: 1, width: "auto" }} placeholder="New staff member / instructor name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name || action.busy}>Add</button>
      </form>
      {staff?.map((s) => <StaffCard key={s.id} staff={s} reload={reload} />)}
    </div>
  );
}

function StaffCard({ staff: s, reload }: { staff: any; reload: () => void }) {
  const { biz } = useBusiness();
  const [hours, setHours] = useState<Block[]>(s.hours);
  const [off, setOff] = useState({ start: "", end: "", reason: "" });
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const [phone, setPhone] = useState(s.phone ?? "");

  const update = (i: number, patch: Partial<Block>) => setHours(hours.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const saveHours = () => action.run(async () => {
    setHours(await api(`/admin/${biz.id}/staff/${s.id}/hours`, { method: "PUT", body: hours.map(({ weekday, start_time, end_time }) => ({ weekday: Number(weekday), start_time, end_time })) }));
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  });
  const toLocalIso = (v: string) => DateTime.fromISO(v, { zone: biz.timezone }).toISO();

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>{s.name}</h2>
        {!s.active && <span className="badge">inactive</span>}
        <div className="spacer" />
        <button onClick={() => action.run(async () => { await api(`/admin/${biz.id}/staff/${s.id}`, { method: "PATCH", body: { active: !s.active } }); reload(); })}>
          {s.active ? "Deactivate" : "Activate"}
        </button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
      <div className="row">
        <input style={{ width: 220 }} type="tel" placeholder="Mobile for appointment texts" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button disabled={phone === (s.phone ?? "")} onClick={() => action.run(async () => { await api(`/admin/${biz.id}/staff/${s.id}`, { method: "PATCH", body: { phone: phone || null } }); reload(); })}>Save phone</button>
        <span className="small muted">Gets an "up next" text before each appointment when enabled under Text messages.</span>
      </div>
      <h3>Weekly hours <span className="muted small">({biz.timezone})</span></h3>
      {hours.map((h, i) => (
        <div key={i} className="row">
          <select style={{ width: 90 }} value={h.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, j) => <option key={d} value={j + 1}>{d}</option>)}
          </select>
          <input style={{ width: 120 }} type="time" value={h.start_time} onChange={(e) => update(i, { start_time: e.target.value })} />
          <span>to</span>
          <input style={{ width: 120 }} type="time" value={h.end_time} onChange={(e) => update(i, { end_time: e.target.value })} />
          <button className="danger" onClick={() => setHours(hours.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="row">
        <button onClick={() => setHours([...hours, { weekday: 1, start_time: "09:00", end_time: "17:00" }])}>+ Add block</button>
        <button className="primary" disabled={action.busy} onClick={saveHours}>Save hours</button>
        {saved && <span className="notice small">Saved</span>}
      </div>
      <h3>Time off</h3>
      {s.time_off.map((t: any) => (
        <div key={t.id} className="row small">
          {DateTime.fromISO(t.starts_at).setZone(biz.timezone).toFormat("ccc d LLL h:mm a")} – {DateTime.fromISO(t.ends_at).setZone(biz.timezone).toFormat("ccc d LLL h:mm a")} {t.reason && `· ${t.reason}`}
          <button className="link danger" onClick={() => action.run(async () => { await api(`/admin/${biz.id}/time-off/${t.id}`, { method: "DELETE" }); reload(); })}>remove</button>
        </div>
      ))}
      <div className="row">
        <input style={{ width: 200 }} type="datetime-local" value={off.start} onChange={(e) => setOff({ ...off, start: e.target.value })} />
        <input style={{ width: 200 }} type="datetime-local" value={off.end} onChange={(e) => setOff({ ...off, end: e.target.value })} />
        <input style={{ width: 160 }} placeholder="Reason" value={off.reason} onChange={(e) => setOff({ ...off, reason: e.target.value })} />
        <button disabled={!off.start || !off.end} onClick={() => action.run(async () => {
          await api(`/admin/${biz.id}/staff/${s.id}/time-off`, { body: { starts_at: toLocalIso(off.start), ends_at: toLocalIso(off.end), reason: off.reason } });
          setOff({ start: "", end: "", reason: "" }); reload();
        })}>Block time</button>
      </div>
    </div>
  );
}
