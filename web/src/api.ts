const TOKEN_KEY = "slotwise.token";

export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

/** Identifies this browser to the server ("remember this device"). Kept when signing out so the device stays trusted. */
const DEVICE_KEY = "slotwise.device";
export const deviceStore = {
  get: () => { try { return localStorage.getItem(DEVICE_KEY) ?? undefined; } catch { return undefined; } },
  set: (t: string | null | undefined) => { try { t ? localStorage.setItem(DEVICE_KEY, t) : localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ } },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const fields = data?.details && typeof data.details === "object"
      ? Object.entries(data.details).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ")
      : "";
    throw new ApiError(res.status, [data?.error ?? res.statusText, fields].filter(Boolean).join(" — "), data?.details);
  }
  return data as T;
}

export const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format((cents ?? 0) / 100);

export const toCents = (dollars: string) => Math.round(parseFloat(dollars || "0") * 100);
