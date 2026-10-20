import { useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { DateTime } from "luxon";
import { api } from "../api";
import { useAuth } from "../auth";
import { useAction, useApi } from "../hooks";
import { passkeyError } from "../components/TwoFactorStep";

interface SecurityInfo {
  twoFactorOn: boolean; emailWorking: boolean; rememberDays: number;
  passkeys: { id: string; name: string; created_at: string; last_used_at: string | null }[];
  devices: { id: string; name: string; verified_with: string | null; trusted: boolean; trusted_until: string | null; created_at: string; last_seen_at: string; current: boolean }[];
}

const when = (iso: string | null) => {
  if (!iso) return "never";
  const d = iso.includes("T") ? DateTime.fromISO(iso) : DateTime.fromSQL(iso, { zone: "utc" });
  return d.toRelative() ?? d.toLocaleString(DateTime.DATETIME_MED);
};

/** Account → Security: passkeys, and every device signed in to this account. */
export function Security() {
  const { logout } = useAuth();
  const { data, reload } = useApi<SecurityInfo>("/auth/security");
  const [notice, setNotice] = useState("");
  const { busy, error, run } = useAction();
  if (!data) return null;

  const addPasskey = () => run(async () => {
    const name = prompt("Name this passkey so you can recognise it later (for example \"MacBook\" or \"iPhone\"):", "");
    if (name === null) return;
    const { challengeId, options } = await api("/auth/passkeys/options", { method: "POST" });
    const response = await startRegistration({ optionsJSON: options }).catch((err) => { throw passkeyError(err); });
    const added = await api("/auth/passkeys", { body: { challengeId, response, name } });
    setNotice(`Passkey "${added.name}" added. Next time, choose "Sign in with a passkey", or use it instead of the emailed code.`);
    reload();
  });
  const removePasskey = (p: SecurityInfo["passkeys"][number]) => run(async () => {
    if (!confirm(`Remove the passkey "${p.name}"? You'll use an emailed code instead.`)) return;
    await api(`/auth/passkeys/${p.id}`, { method: "DELETE" });
    reload();
  });
  const signOut = (d: SecurityInfo["devices"][number]) => run(async () => {
    if (!confirm(d.current ? "Sign out this device? You'll need your password and a code to sign back in." : `Sign out "${d.name}"? It will need a password and a code to sign in again.`)) return;
    const r = await api(`/auth/devices/${d.id}`, { method: "DELETE" });
    if (r.signedOut) { logout(); window.location.href = "/login"; return; }
    reload();
  });
  const signOutOthers = () => run(async () => {
    if (!confirm("Sign out every other device? They'll need a password and a code to sign back in.")) return;
    const r = await api("/auth/devices/sign-out-others", { method: "POST" });
    setNotice(`${r.count} other device${r.count === 1 ? "" : "s"} signed out.`);
    reload();
  });

  return (
    <div className="card stack">
      <h2>Security</h2>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {data.twoFactorOn ? (
        <p className="small">✅ <b>Two-step sign-in is on.</b> Signing in on a new device needs your password (or Google/Apple) <i>and</i> a code we email you, or a passkey. Devices you choose to remember skip the code for {data.rememberDays} days.</p>
      ) : (
        <div className="error small">Two-step sign-in is paused because Slotwise can't send email right now. {data.emailWorking ? "" : "Add a passkey below to protect your account in the meantime."}</div>
      )}

      <h3 style={{ marginBottom: 0 }}>🔑 Passkeys</h3>
      <p className="small muted" style={{ marginTop: 0 }}>A passkey lets you sign in with your fingerprint, face or device PIN instead of a password and code. It's stored on your device (or synced by Apple, Google or Microsoft) and can't be phished.</p>
      {data.passkeys.map((p) => (
        <div key={p.id} className="row">
          <span><b>{p.name}</b> <span className="small muted">added {when(p.created_at)} · last used {when(p.last_used_at)}</span></span>
          <div className="spacer" />
          <button className="danger" disabled={busy} onClick={() => removePasskey(p)}>Remove</button>
        </div>
      ))}
      {browserSupportsWebAuthn()
        ? <div><button disabled={busy} onClick={addPasskey}>+ Add a passkey on this device</button></div>
        : <p className="small muted">This browser doesn't support passkeys.</p>}

      <h3 style={{ marginBottom: 0 }}>💻 Signed-in devices</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Device</th><th>Last active</th><th>Remembered</th><th /></tr></thead>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}{d.current && <> <span className="badge ok">this device</span></>}<div className="small muted">signed in {when(d.created_at)}{d.verified_with ? ` · checked with ${d.verified_with === "reset" ? "a reset link" : d.verified_with === "email" ? "an emailed code" : "a passkey"}` : ""}</div></td>
                <td>{when(d.last_seen_at)}</td>
                <td>{d.trusted ? `until ${DateTime.fromISO(d.trusted_until!).toLocaleString(DateTime.DATE_MED)}` : "no"}</td>
                <td><button className="danger" disabled={busy} onClick={() => signOut(d)}>Sign out</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.devices.length > 1 && <div><button className="danger" disabled={busy} onClick={signOutOthers}>Sign out all other devices</button></div>}
      <p className="small muted">Don't recognise a device? Sign it out and change your password. We also email you whenever a new device signs in.</p>
    </div>
  );
}
