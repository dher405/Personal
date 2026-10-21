import { one, run } from "../db.js";

export interface Plan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  maxStaff: number;
  aiChat: boolean;
  /** Monthly allowances (usage-based pricing). Packs or an upgrade add more; see lib/usage.ts. */
  bookingsPerMonth: number;
  aiMessagesPerMonth: number;
  /** Shown on the home page and offered on businesses' Plan & billing page. Hidden plans (e.g. for testers) are assigned by the super admin. */
  visible: boolean;
}

export const DEFAULT_PLANS: Plan[] = [
  { id: "free", name: "Starter", monthlyPriceCents: 0, maxStaff: 1, aiChat: false, bookingsPerMonth: 25, aiMessagesPerMonth: 0, visible: true },
  { id: "pro", name: "Pro", monthlyPriceCents: 2900, maxStaff: 5, aiChat: true, bookingsPerMonth: 300, aiMessagesPerMonth: 1000, visible: true },
  { id: "business", name: "Business", monthlyPriceCents: 7900, maxStaff: 50, aiChat: true, bookingsPerMonth: 2000, aiMessagesPerMonth: 5000, visible: true },
];

const ALLOWANCES = ["bookingsPerMonth", "aiMessagesPerMonth"] as const;

export function getPlans(): Plan[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'plans'");
  // Plans saved before a meter existed get that meter's default for their id.
  const plans: Plan[] = row ? JSON.parse(row.value) : DEFAULT_PLANS;
  return plans.map((p) => {
    const d = DEFAULT_PLANS.find((x) => x.id === p.id);
    // Older saved plans may carry a per-payment fee or a text allowance; neither is used any more
    // (businesses take payments and send texts with their own accounts).
    const { platformFeeBps: _fee, smsPerMonth: _sms, ...filled } = p as Plan & { platformFeeBps?: number; smsPerMonth?: number };
    for (const k of ALLOWANCES) filled[k] = p[k] ?? d?.[k] ?? 0;
    filled.visible = p.visible ?? true; // plans saved before this setting existed were all shown
    return filled;
  });
}

/** Extra uses a business can buy when it runs low. Edited by the super admin. */
export interface UsagePack { id: string; metric: "bookings" | "ai"; quantity: number; priceCents: number }

export const DEFAULT_PACKS: UsagePack[] = [
  { id: "bookings-50", metric: "bookings", quantity: 50, priceCents: 1000 },
  { id: "ai-250", metric: "ai", quantity: 250, priceCents: 1000 },
];

export function getPacks(): UsagePack[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'packs'");
  // Text packs saved before businesses used their own Twilio accounts are dropped.
  return row ? (JSON.parse(row.value) as UsagePack[]).filter((p) => p.metric === "bookings" || p.metric === "ai") : DEFAULT_PACKS;
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

/** The plans businesses can see and choose (plus the one a business is already on, even if it's hidden). */
export const visiblePlans = (currentPlanId?: string) => getPlans().filter((p) => p.visible || p.id === currentPlanId);

export function getPlan(id: string): Plan {
  const plans = getPlans();
  return plans.find((p) => p.id === id) ?? plans[0];
}
