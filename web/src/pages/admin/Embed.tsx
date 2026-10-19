import { useState } from "react";
import { useApi } from "../../hooks";
import { useBusiness } from "./AdminLayout";

type Mode = "inline" | "button" | "floating" | "link";

function CopyBox({ value, rows = 2 }: { value: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <textarea readOnly rows={rows} value={value} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, minHeight: 0 }} />
      <div className="row">
        <button onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

/** "Add to website": copy-paste code for the business's own site, with a live preview. */
export function Embed() {
  const { biz } = useBusiness();
  const { data: services } = useApi<any[]>(`/admin/${biz.id}/services`);
  const origin = window.location.origin;
  const [mode, setMode] = useState<Mode>("inline");
  const [serviceId, setServiceId] = useState("");
  const [label, setLabel] = useState("Book now");
  const [color, setColor] = useState("#2f6fed");
  const [header, setHeader] = useState(true);

  const link = `${origin}/b/${biz.slug}`;
  const attrs = [
    `data-business="${biz.slug}"`,
    mode !== "inline" ? `data-mode="${mode}"` : "",
    mode !== "inline" && label !== "Book now" ? `data-label="${label.replace(/"/g, "&quot;")}"` : "",
    serviceId ? `data-service="${serviceId}"` : "",
    color.toLowerCase() !== "#2f6fed" ? `data-color="${color}"` : "",
    !header ? `data-header="0"` : "",
  ].filter(Boolean).join(" ");
  const snippet = mode === "link"
    ? `<a href="${link}${serviceId ? `?service=${serviceId}` : ""}" target="_blank" rel="noopener">${label}</a>`
    : `<script src="${origin}/embed.js" ${attrs} async></script>`;
  const preview = `${origin}/embed/${biz.slug}?color=${color.slice(1)}${serviceId ? `&service=${serviceId}` : ""}${header ? "" : "&header=0"}`;

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Your booking link</h2>
        <p className="small muted">Share it anywhere: Instagram or Facebook bio, Google Business Profile, email signature, text messages, flyers.</p>
        <CopyBox value={link} rows={1} />
      </div>

      <div className="card stack">
        <h2>Put booking on your website</h2>
        <p className="small muted">Pick a style, copy the code, and paste it into your website where you want it. Most website builders have an "Embed", "HTML" or "Custom code" block for this.</p>
        <div className="row">
          {([["inline", "Calendar on the page"], ["button", "Button that opens a pop-up"], ["floating", "Floating button on every page"], ["link", "Plain link"]] as const).map(([m, l]) => (
            <button key={m} className={mode === m ? "primary" : ""} onClick={() => setMode(m)}>{l}</button>
          ))}
        </div>
        <div className="form-grid">
          <label>Start on one service (optional)
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Let customers choose</option>
              {services?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {mode !== "inline" && <label>Button text<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>}
          {mode !== "link" && <label>Colour<input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ height: 38, padding: 4 }} /></label>}
          {mode !== "link" && <label className="inline" style={{ alignSelf: "end" }}><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Show business name and address</label>}
        </div>
        <CopyBox value={snippet} rows={3} />
        {mode === "button" || mode === "floating" ? (
          <p className="small muted">Already have your own "Book" button? Paste the code once anywhere on the page, then add <code>data-slotwise-open</code> to your button or link and it will open the same pop-up.</p>
        ) : null}
      </div>

      <div className="card stack">
        <h2>Preview</h2>
        <p className="small muted">This is what visitors see{mode === "inline" ? " on your page" : " after clicking the button"}. It's live: bookings made here are real.</p>
        <iframe title="Booking preview" src={preview} style={{ width: "100%", height: 640, border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />
      </div>
    </div>
  );
}
