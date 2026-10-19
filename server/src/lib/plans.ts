import { one, run } from "../db.js";

export interface Plan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  maxStaff: number;
  aiChat: boolean;
  /** Monthly allowances (usage-based pricing). Packs or an upgrade add more; see lib/usage.ts. */
  bookingsPerMonth: number;
  smsPerMonth: number;
  aiMessagesPerMonth: number;
}

export const DEFAULT_PLANS: Plan[] = [
  { id: "free", name: "Starter", monthlyPriceCents: 0, maxStaff: 1, aiChat: false, bookingsPerMonth: 25, smsPerMonth: 50, aiMessagesPerMonth: 0 },
  { id: "pro", name: "Pro", monthlyPriceCents: 2900, maxStaff: 5, aiChat: true, bookingsPerMonth: 300, smsPerMonth: 500, aiMessagesPerMonth: 1000 },
  { id: "business", name: "Business", monthlyPriceCents: 7900, maxStaff: 50, aiChat: true, bookingsPerMonth: 2000, smsPerMonth: 2000, aiMessagesPerMonth: 5000 },
];

const ALLOWANCES = ["bookingsPerMonth", "smsPerMonth", "aiMessagesPerMonth"] as const;

export function getPlans(): Plan[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'plans'");
  // Plans saved before a meter existed get that meter's default for their id.
  const plans: Plan[] = row ? JSON.parse(row.value) : DEFAULT_PLANS;
  return plans.map((p) => {
    const d = DEFAULT_PLANS.find((x) => x.id === p.id);
    // Plans saved when there was a per-payment fee still carry platformFeeBps; it's no longer used.
    const { platformFeeBps: _unused, ...filled } = p as Plan & { platformFeeBps?: number };
    for (const k of ALLOWANCES) filled[k] = p[k] ?? d?.[k] ?? 0;
    return filled;
  });
}

/** Extra uses a business can buy when it runs low. Edited by the super admin. */
export interface UsagePack { id: string; metric: "bookings" | "sms" | "ai"; quantity: number; priceCents: number }

export const DEFAULT_PACKS: UsagePack[] = [
  { id: "bookings-50", metric: "bookings", quantity: 50, priceCents: 1000 },
  { id: "sms-100", metric: "sms", quantity: 100, priceCents: 500 },
  { id: "ai-250", metric: "ai", quantity: 250, priceCents: 1000 },
];

export function getPacks(): UsagePack[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'packs'");
  return row ? JSON.parse(row.value) : DEFAULT_PACKS;
}

export function savePacks(packs: UsagePack[]) {
  run("INSERT INTO platform_settings (key, value) VALUES ('packs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(packs));
}

export function savePlans(plans: Plan[]) {
  run(
    "INSERT INTO platform_settings (key, value) VALUES ('plans', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(plans),
  );
}

export function getPlan(id: string): Plan {
  const plans = getPlans();
  return plans.find((p) => p.id === id) ?? plans[0];
}
