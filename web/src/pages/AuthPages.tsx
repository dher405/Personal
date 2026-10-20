import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { useAction, useApi } from "../hooks";
import { SocialButtons } from "../components/SocialButtons";

export const landing = (role: string) => (role === "superadmin" ? "/super/businesses" : role === "admin" ? "/admin" : "/me");

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const providerError = params.get("error");
  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => nav(landing((await login(email, password)).user.role))); }}>
        <h1>Sign in</h1>
        {providerError && <div className="error">{providerError}</div>}
        {params.get("reset") && <div className="notice">Password updated. You're signed in on this device only.</div>}
        {/* The home page's "Business sign in" passes next=/admin so owners land in their admin. */}
        <SocialButtons next={params.get("next")?.startsWith("/") ? params.get("next")! : "/me"} />
        {error && <div className="error">{error}</div>}
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="primary" disabled={busy}>Sign in</button>
          <Link to={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`} className="small">Forgot password?</Link>
        </div>
        <span className="muted small">New here? <Link to="/register">Create an account</Link></span>
      </form>
    </div>
  );
}

export function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [provider, setProvider] = useState(params.get("provider") === "1");
  const { busy, error, run } = useAction();
  const [form, setForm] = useState({ name: "", email: "", password: "", businessName: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = () => run(async () => {
    const body: Record<string, string> = { name: form.name, email: form.email, password: form.password };
    if (provider) Object.assign(body, { businessName: form.businessName, timezone: form.timezone });
    const s = await register(body);
    nav(provider ? `/admin/${s.businesses[0].id}/setup` : "/");
  });

  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h1>{provider ? "List your business" : "Create an account"}</h1>
        <label className="inline"><input type="checkbox" checked={provider} onChange={(e) => setProvider(e.target.checked)} /> I want to offer services / take bookings</label>
        <SocialButtons intent={provider ? "business" : "signin"} next={provider ? "/start-business" : "/"} />
        {error && <div className="error">{error}</div>}
        <label>Your name<input required value={form.name} onChange={set("name")} /></label>
        <label>Email<input type="email" autoComplete="email" required value={form.email} onChange={set("email")} /></label>
        <label>Password (8+ characters)<input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set("password")} /></label>
        {provider && (
          <>
            <label>Business name<input required value={form.businessName} onChange={set("businessName")} /></label>
            <label>Timezone<input required value={form.timezone} onChange={set("timezone")} /></label>
          </>
        )}
        <span className="small muted">By creating an account you agree to the <Link to="/terms" target="_blank">Terms of Service</Link> and <Link to="/privacy" target="_blank">Privacy Policy</Link>.</span>
        <button className="primary" disabled={busy}>Create account</button>
        <span className="muted small">Already have an account? <Link to="/login">Sign in</Link></span>
      </form>
    </div>
  );
}

export function ForgotPassword() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => setMessage((await api("/auth/forgot-password", { body: { email } })).message)); }}>
        <h1>Reset your password</h1>
        <p className="muted">Enter the email you sign in with and we'll send you a link to choose a new password.</p>
        {message ? <div className="notice">{message}</div> : (
          <>
            {error && <div className="error">{error}</div>}
            <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <button className="primary" disabled={busy}>Send reset link</button>
          </>
        )}
        <span className="small"><Link to="/login">Back to sign in</Link></span>
      </form>
    </div>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { accept } = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy, error, run, setError } = useAction();

  const submit = () => {
    if (password !== confirm) return setError("The two passwords don't match");
    run(async () => {
      const s = accept(await api("/auth/reset-password", { body: { token, password } }));
      nav(landing(s.user.role));
    });
  };

  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h1>Choose a new password</h1>
        {!token && <div className="error">This link is missing its code. Open the link from your email again, or <Link to="/forgot-password">request a new one</Link>.</div>}
        {error && <div className="error">{error} {error.includes("expired") && <Link to="/forgot-password">Request a new link</Link>}</div>}
        <label>New password (8+ characters)<input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <button className="primary" disabled={busy || !token}>Save password and sign in</button>
        <p className="small muted">For your security, this signs you out on all other devices.</p>
      </form>
    </div>
  );
}

/** Google/Apple send people back here with the session token in the URL fragment. */
export function AuthCallback() {
  const { signInWithToken } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get("token");
    const next = hash.get("next") ?? "/";
    history.replaceState(null, "", window.location.pathname); // don't leave the token in the address bar / history
    if (!token) { setError("Sign-in didn't complete. Please try again."); return; }
    signInWithToken(token)
      .then((s) => nav(next === "/me" || next === "/" ? landing(s.user.role) : next, { replace: true }))
      .catch(() => setError("Sign-in didn't complete. Please try again."));
  }, []);
  return (
    <div className="container narrow">
      {error ? <div className="card stack"><div className="error">{error}</div><Link to="/login">Back to sign in</Link></div> : <p className="muted">Signing you in…</p>}
    </div>
  );
}

/** After "List your business" with Google/Apple: name the business, then go to its admin. */
export function StartBusiness() {
  const { session, accept } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const { busy, error, run } = useAction();
  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => {
        const res = await api("/auth/businesses", { body: { name, timezone } });
        accept(res.session);
        nav(`/admin/${res.business.id}/setup`);
      }); }}>
        <h1>Set up your business</h1>
        <p className="muted">Signed in as {session?.user.email}.</p>
        {error && <div className="error">{error}</div>}
        <label>Business name<input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Timezone<input required value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
        <button className="primary" disabled={busy}>Create business</button>
      </form>
    </div>
  );
}

/** Password and connected sign-in methods. */
export function Account() {
  const { session, accept } = useAuth();
  const { data, reload } = useApi<{ hasPassword: boolean; identities: { provider: string; email: string }[] }>("/auth/account");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  if (!data) return <div className="container muted">Loading…</div>;
  return (
    <div className="container narrow">
      <div className="card stack">
        <h1>Account</h1>
        <p>{session?.user.name} · {session?.user.email}</p>
        <h3>Sign-in methods</h3>
        <div className="row">
          {data.hasPassword && <span className="badge ok">Email &amp; password</span>}
          {data.identities.map((i) => <span key={i.provider} className="badge ok">{i.provider === "google" ? "Google" : "Apple"}{i.email ? ` (${i.email})` : ""}</span>)}
        </div>
        <p className="small muted">To connect Google or Apple, sign out and use "Continue with Google/Apple" with the same email address.</p>
      </div>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => {
        accept(await api("/auth/change-password", { body: { currentPassword: current || undefined, newPassword: next } }));
        setCurrent(""); setNext(""); setSaved(true); reload();
      }); }}>
        <h2>{data.hasPassword ? "Change password" : "Add a password"}</h2>
        {!data.hasPassword && <p className="small muted">Optional. Lets you sign in with your email too, not only Google/Apple.</p>}
        {error && <div className="error">{error}</div>}
        {saved && <div className="notice">Password saved. Other devices have been signed out.</div>}
        {data.hasPassword && <label>Current password<input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>}
        <label>New password (8+ characters)<input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <div><button className="primary" disabled={busy}>Save password</button></div>
      </form>
    </div>
  );
}
