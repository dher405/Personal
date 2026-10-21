import { config } from "../config.js";
import { all, audit, one, run } from "../db.js";

/**
 * Stripe keeps test (sandbox) and live data apart: customers and subscriptions made with sk_test_ keys don't exist
 * for sk_live_ keys. When the platform's key switches mode, businesses' saved Stripe ids belong to the other mode,
 * so they're cleared. Businesses subscribed in test mode never paid real money, so they move back to Starter (plans
 * the super admin gave directly, with no subscription, are kept). Runs at startup and whenever the key is saved.
 */
export function syncStripeMode() {
  if (!config.stripe.secretKey) return null;
  const mode = config.stripe.mode;
  const saved = one<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'stripe_mode'")?.value;
  if (saved === mode) return null;
  run("INSERT INTO platform_settings (key, value) VALUES ('stripe_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mode);
  if (!saved) return null; // first time: nothing to compare with

  const subscribed = all("SELECT id, plan FROM businesses WHERE platform_subscription_id IS NOT NULL");
  for (const b of subscribed) {
    run("UPDATE businesses SET plan = 'free', plan_status = 'active', plan_ends_at = NULL WHERE id = ?", b.id);
    audit({ label: "stripe-mode-switch" }, b.id, "plan.changed", { planId: "free", reason: `${saved}-mode subscription doesn't exist in ${mode} mode`, previousPlan: b.plan });
  }
  const cleared = run("UPDATE businesses SET platform_customer_id = NULL, platform_subscription_id = NULL WHERE platform_customer_id IS NOT NULL OR platform_subscription_id IS NOT NULL").changes;
  audit({ label: "stripe-mode-switch" }, null, "billing.stripe_mode_changed", { from: saved, to: mode, businessesCleared: cleared, movedToStarter: subscribed.length });
  return { from: saved, to: mode, cleared, movedToStarter: subscribed.length };
}
