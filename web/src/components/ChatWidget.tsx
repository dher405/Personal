import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Msg { role: "user" | "assistant"; text: string; paymentUrl?: string; manageUrl?: string }

/** Chat UI for both the public booking assistant and the admin assistant. */
export function ChatWidget({ endpoint, greeting, onEvent, storageKey }: {
  endpoint: string;
  greeting: string;
  storageKey: string;
  onEvent?: (event: any) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", text: greeting }]);
  const [sessionId, setSessionId] = useState<string | undefined>(() => { try { return sessionStorage.getItem(storageKey) ?? undefined; } catch { return undefined; } });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [messages, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await api<{ sessionId: string; reply: string; events: any[] }>(endpoint, { body: { message: text, sessionId } });
      setSessionId(res.sessionId);
      try { sessionStorage.setItem(storageKey, res.sessionId); } catch { /* ignore */ }
      const created = res.events.find((e) => e.type === "booking_created");
      setMessages((m) => [...m, { role: "assistant", text: res.reply, paymentUrl: created?.paymentUrl, manageUrl: created?.booking?.manageUrl }]);
      res.events.forEach((e) => onEvent?.(e));
    } catch (e) {
      // A stale session (e.g. server DB reset) — start fresh on the next message.
      if ((e as any).status === 404) { setSessionId(undefined); try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ } }
      setMessages((m) => [...m, { role: "assistant", text: `Sorry — ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSessionId(undefined);
    try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
    setMessages([{ role: "assistant", text: greeting }]);
  };

  return (
    <div className="chat">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>AI assistant</strong>
        <button className="link small" onClick={reset}>New chat</button>
      </div>
      <div className="chat-log" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
            {m.paymentUrl && <div><a className="btn primary" style={{ marginTop: 8 }} href={m.paymentUrl}>Pay to confirm</a></div>}
            {!m.paymentUrl && m.manageUrl && <div><a href={m.manageUrl}>View booking</a></div>}
          </div>
        ))}
        {busy && <div className="bubble assistant muted">Thinking…</div>}
      </div>
      <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message…" aria-label="Message" />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
