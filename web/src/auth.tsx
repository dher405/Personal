import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, deviceStore, tokenStore } from "./api";

export interface User { id: string; email: string; name: string; role: "superadmin" | "admin" | "customer" }
export interface BusinessRef { id: string; name: string; slug: string }
interface Session { user: User; businesses: BusinessRef[] }
type SessionResponse = Session & { token: string; deviceToken?: string; next?: string | null };

/** The second step of signing in: an emailed code or a passkey (see components/TwoFactorStep). */
export interface TwoFactor { id: string; email: string; codeSent: boolean; methods: ("email" | "passkey")[]; rememberDays: number; next?: string | null }
/** A sign-in either finishes (session) or needs the second step (twoFactor). */
export type SignInResult = { session: Session; next?: string | null; twoFactor?: undefined } | { twoFactor: TwoFactor; session?: undefined };

interface AuthValue {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<SignInResult>;
  register: (body: Record<string, string>) => Promise<SignInResult>;
  logout: () => void;
  refresh: () => Promise<void>;
  /** Accepts a session returned by the API (reset password, second step, new business). */
  accept: (s: SessionResponse) => Session;
  /** Turns a sign-in response into a session, or the second step it still needs. */
  settle: (res: SessionResponse | { twoFactor: TwoFactor }) => SignInResult;
}

const AuthContext = createContext<AuthValue>(null!);

/** What every sign-in request sends: which device this is, so a remembered device skips the second step. */
export const deviceFields = () => ({ deviceToken: deviceStore.get() });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const accept = (s: SessionResponse) => {
    tokenStore.set(s.token);
    if (s.deviceToken) deviceStore.set(s.deviceToken);
    const value = { user: s.user, businesses: s.businesses };
    setSession(value);
    return value;
  };
  const settle = (res: SessionResponse | { twoFactor: TwoFactor }): SignInResult =>
    "twoFactor" in res && res.twoFactor ? { twoFactor: res.twoFactor } : { session: accept(res as SessionResponse), next: (res as SessionResponse).next };
  const refresh = async () => {
    if (!tokenStore.get()) return;
    try { accept(await api("/auth/me")); } catch { tokenStore.set(null); setSession(null); }
  };

  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  return (
    <AuthContext.Provider value={{
      session, loading, refresh, accept, settle,
      login: async (email, password) => settle(await api("/auth/login", { body: { email, password, ...deviceFields() } })),
      register: async (body) => settle(await api("/auth/register", { body: { ...body, ...deviceFields() } })),
      logout: () => { tokenStore.set(null); setSession(null); },
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
