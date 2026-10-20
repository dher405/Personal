import { useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { api } from "../api";
import { deviceFields, useAuth, type SignInResult, type TwoFactor } from "../auth";
import { useAction } from "../hooks";

/** Turns a passkey prompt the person closed into a plain message rather than a browser error. */
export function passkeyError(err: unknown) {
  const e = err as Error;
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return new Error("The passkey request was cancelled or timed out. Try again, or use another way to sign in.");
  return e;
}

/** Signs in with a passkey alone (no email or password): the passkey counts as both steps. */
export async function passkeySignIn(settle: (r: any) => SignInResult, remember = true) {
  const { challengeId, options } = await api("/auth/passkey/options", { body: {} });
  const response = await startAuthentication({ optionsJSON: options }).catch((err) => { throw passkeyError(err); });
  return settle(await api("/auth/passkey/verify", { body: { challengeId, response, remember, ...deviceFields() } }));
}

/**
 * The second step of signing in: the 6-digit code we emailed, or a passkey. Shown after a password, after
 * Google/Apple, and when creating an account (where the code also confirms the email address).
 */
export function TwoFactorStep({ challenge: initial, purpose = "login", onDone, onCancel }: {
  challenge: TwoFactor; purpose?: "login" | "register"; onDone: (r: Extract<SignInResult, { session: object }>) => void; onCancel?: () => void;
}) {
  const { settle } = useAuth();
  const [challenge, setChallenge] = useState(initial);
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [notice, setNotice] = useState("");
  const { busy, error, run } = useAction();
  const canPasskey = challenge.methods.includes("passkey") && browserSupportsWebAuthn();
  const canEmail = challenge.methods.includes("email");
  const done = (r: SignInResult) => { if (r.session) onDone(r); };

  const verify = () => run(async () => done(settle(await api("/auth/2fa/verify", { body: { challengeId: challenge.id, code, remember, ...deviceFields() } }))));
  const sendCode = () => run(async () => {
    setChallenge({ ...challenge, ...(await api("/auth/2fa/send-code", { body: { challengeId: challenge.id } })) });
    setNotice(`We've emailed a new code to ${challenge.email}.`);
  });
  const usePasskey = () => run(async () => {
    const { options } = await api("/auth/passkey/options", { body: { challengeId: challenge.id } });
    const response = await startAuthentication({ optionsJSON: options }).catch((err) => { throw passkeyError(err); });
    done(settle(await api("/auth/passkey/verify", { body: { challengeId: challenge.id, response, remember, ...deviceFields() } })));
  });

  return (
    <div className="stack">
      <h1>{purpose === "register" ? "Confirm your email" : "Check it's you"}</h1>
      {error && <div className="error">{error}</div>}
      {notice && !error && <div className="notice">{notice}</div>}
      {canPasskey && (
        <>
          <p>Use the passkey on this device (fingerprint, face or PIN) to finish signing in.</p>
          <div><button type="button" className={challenge.codeSent ? "" : "primary"} disabled={busy} onClick={usePasskey}>🔑 Use my passkey</button></div>
        </>
      )}
      {canEmail && (challenge.codeSent ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <p>We emailed a 6-digit code to <b>{challenge.email}</b>. It expires in 10 minutes.</p>
          <label>Code
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required placeholder="123456"
              style={{ fontSize: "1.4rem", letterSpacing: ".3em", maxWidth: 200 }} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || code.replace(/\D/g, "").length !== 6}>Verify</button>
            <button type="button" className="link" disabled={busy} onClick={sendCode}>Send a new code</button>
          </div>
          <p className="small muted">Can't find it? Check your spam or junk folder for an email from Slotwise.</p>
        </form>
      ) : (
        <div><button type="button" className="link" disabled={busy} onClick={sendCode}>Email me a code instead</button></div>
      ))}
      <label className="inline small">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this device for {challenge.rememberDays} days (don't tick this on a shared or public computer)
      </label>
      {onCancel && <span className="small"><button type="button" className="link" onClick={onCancel}>← Start again</button></span>}
    </div>
  );
}
