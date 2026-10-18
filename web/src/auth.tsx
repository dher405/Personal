import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, tokenStore } from "./api";

export interface User { id: string; email: string; name: string; role: "superadmin" | "admin" | "customer" }
export interface BusinessRef { id: string; name: string; slug: string }
interface Session { user: User; businesses: BusinessRef[] }

interface AuthValue {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Session>;
  register: (body: Record<string, string>) => Promise<Session>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const accept = (s: Session & { token: string }) => { tokenStore.set(s.token); setSession(s); return s; };
  const refresh = async () => {
    if (!tokenStore.get()) return;
    try { accept(await api("/auth/me")); } catch { tokenStore.set(null); setSession(null); }
  };

  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  return (
    <AuthContext.Provider value={{
      session, loading, refresh,
      login: async (email, password) => accept(await api("/auth/login", { body: { email, password } })),
      register: async (body) => accept(await api("/auth/register", { body })),
      logout: () => { tokenStore.set(null); setSession(null); },
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
