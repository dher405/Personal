import { useState } from "react";
import { api } from "../../api";
import { useAction } from "../../hooks";
import { ChatWidget } from "../../components/ChatWidget";
import { useBusiness } from "./AdminLayout";

export function AiSettings() {
  const { biz, reloadBiz, base } = useBusiness();
  const [enabled, setEnabled] = useState(!!biz.ai_enabled);
  const [instructions, setInstructions] = useState(biz.ai_instructions);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const planAllows = biz.plan_details.aiChat;

  const save = () => action.run(async () => {
    await api(`/admin/${biz.id}`, { method: "PATCH", body: { ai_enabled: enabled, ai_instructions: instructions } });
    reloadBiz(); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
      <div className="card stack">
        <h2>Customer chat on your booking page</h2>
        <p className="muted small">Customers can ask questions, see open times, book, reschedule and cancel by chatting. It only offers times your calendar actually has open.</p>
        {!planAllows && <div className="error">AI chat is included on paid plans. <a href={`${base}/billing`}>Upgrade</a></div>}
        {action.error && <div className="error">{action.error}</div>}
        <label className="inline"><input type="checkbox" checked={enabled} disabled={!planAllows} onChange={(e) => setEnabled(e.target.checked)} /> Enable AI booking chat</label>
        <label>Instructions for the assistant
          <textarea rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)}
            placeholder={"e.g. New students should start with the free trial lesson.\nWe don't teach drums.\nParking is behind the building."} />
        </label>
        <div className="row"><button className="primary" disabled={action.busy} onClick={save}>Save</button>{saved && <span className="notice small">Saved</span>}</div>
        {biz.ai_enabled && !biz.ai_chat_active && planAllows && <p className="small muted">Enabled, but the server has no AI key configured yet.</p>}
      </div>
      <div className="card">
        <ChatWidget
          endpoint={`/admin/${biz.id}/assistant`}
          storageKey={`admin-chat:${biz.id}`}
          greeting={'Ask me to manage your calendar, e.g. "What\'s on tomorrow?", "Move Jo\'s lesson to Friday at 3", or "Block Alex off next Monday".'}
        />
      </div>
    </div>
  );
}
