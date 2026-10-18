import { one, run } from "../db.js";

export interface Plan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  /** Percentage (in basis points, 100 = 1%) the platform keeps from each customer payment. */
  platformFeeBps: number;
  maxStaff: number;
  aiChat: boolean;
  /** Text messages included per month; sending stops (and is logged) once used up. */
  smsPerMonth: number;
}

export const DEFAULT_PLANS: Plan[] = [
  { id: "free", name: "Starter", monthlyPriceCents: 0, platformFeeBps: 300, maxStaff: 1, aiChat: false, smsPerMonth: 50 },
  { id: "pro", name: "Pro", monthlyPriceCents: 2900, platformFeeBps: 100, maxStaff: 5, aiChat: true, smsPerMonth: 500 },
  { id: "business", name: "Business", monthlyPriceCents: 7900, platformFeeBps: 0, maxStaff: 50, aiChat: true, smsPerMonth: 2000 },
];

export function getPlans(): Plan[] {
  const row = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'plans'");
  // Plans saved before SMS existed get the default allowance for their id.
  const plans: Plan[] = row ? JSON.parse(row.value) : DEFAULT_PLANS;
  return plans.map((p) => ({ ...p, smsPerMonth: p.smsPerMonth ?? DEFAULT_PLANS.find((d) => d.id === p.id)?.smsPerMonth ?? 0 }));
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
