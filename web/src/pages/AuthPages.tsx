import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { useAction } from "../hooks";

const landing = (role: string) => (role === "superadmin" ? "/super" : role === "admin" ? "/admin" : "/me");

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div className="container narrow">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => nav(landing((await login(email, password)).user.role))); }}>
        <h1>Sign in</h1>
        {error && <div className="error">{error}</div>}
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="primary" disabled={busy}>Sign in</button>
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
        {error && <div className="error">{error}</div>}
        <label>Your name<input required value={form.name} onChange={set("name")} /></label>
        <label>Email<input type="email" required value={form.email} onChange={set("email")} /></label>
        <label>Password (8+ characters)<input type="password" required minLength={8} value={form.password} onChange={set("password")} /></label>
        {provider && (
          <>
            <label>Business name<input required value={form.businessName} onChange={set("businessName")} /></label>
            <label>Timezone<input required value={form.timezone} onChange={set("timezone")} /></label>
          </>
        )}
        <button className="primary" disabled={busy}>Create account</button>
      </form>
    </div>
  );
}
