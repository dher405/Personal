import { one, run } from "../db.js";

export interface Plan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  /** Percentage (in basis points, 100 = 1%) the platform keeps from each customer payment. */
  platformFeeBps: number;
  maxStaff: number;
  aiChat: boolean;
}

export const DEFAULT_PLANS: Plan[] = [
  { id: "free", name: "Starter", monthlyPriceCents: 0, platformFeeBps: 300, maxStaff: 1, aiChat: false },
  { id: "pro", name: "Pro", monthlyPriceCents: 2900, platformFeeBps: 100, maxStaff: 5, aiChat: true },
  { id: "business", name: "Business", monthlyPriceCents: 7900, platformFeeBps: 0, maxStaff: 50, aiChat: true },
];

export function getPlans(): Plan[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'plans'");
  return row ? JSON.parse(row.value) : DEFAULT_PLANS;
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

export function platformFeeFor(planId: string, amountCents: number) {
  return Math.round((amountCents * getPlan(planId).platformFeeBps) / 10_000);
}
