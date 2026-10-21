import type Stripe from "stripe";
import { config } from "../config.js";
import { all, audit, one, run, Row } from "../db.js";
import { stripe } from "../payments/stripe.js";
import type { AuthUser } from "./auth.js";
import { badRequest } from "./errors.js";
import { getPlan, getPlans } from "./plans.js";

type Actor = { id?: string | null; label: string };

export function setPlan(businessId: string, planId: string, status: string, actor: Actor, subscriptionId?: string | null) {
  if (!getPlans().some((p) => p.id === planId)) throw badRequest("Unknown plan");
  run(
    "UPDATE businesses SET plan = ?, plan_status = ?, platform_subscription_id = COALESCE(?, platform_subscription_id) WHERE id = ?",
    planId, status, subscriptionId ?? null, businessId,
  );
  audit(actor, businessId, "plan.changed", { planId, status });
}

/**
 * Subscribing to a paid plan goes through Stripe Billing on the platform's own
 * Stripe account. Without STRIPE_SECRET_KEY (local dev) the plan is applied directly.
 */
export async function startPlanCheckout(business: Row, planId: string, user: AuthUser, actor: Actor) {
  const plan = getPlan(planId);
  if (plan.id !== planId) throw badRequest("Unknown plan");
  // Hidden plans (e.g. "tester") can only be given by the super admin, under Super admin → Businesses.
  if (!plan.visible && plan.id !== business.plan && user.role !== "superadmin") throw badRequest("That plan isn't available");
  const returnUrl = `${config.webUrl}/admin/${business.id}/billing`;

  // Moving to Starter: they keep the paid plan for the time they've already paid for, and Stripe ends
  // the subscription at the end of that period (customer.subscription.deleted then moves them to Starter).
  if (plan.monthlyPriceCents === 0 && business.platform_subscription_id && config.stripe.secretKey) {
    const current = await stripe().subscriptions.retrieve(business.platform_subscription_id);
    if (current.status !== "canceled") {
      const sub = await stripe().subscriptions.update(current.id, { cancel_at_period_end: true });
      setPlanEnd(business.id, subscriptionEnd(sub), actor);
      return { applied: true, url: returnUrl };
    }
  }

  if (plan.monthlyPriceCents === 0 || !config.stripe.secretKey) {
    setPlan(business.id, plan.id, "active", actor);
    setPlanEnd(business.id, null, actor);
    return { applied: true, url: returnUrl };
  }

  // Existing subscriber: swap the price on the current subscription instead of creating a second one.
  if (business.platform_subscription_id) {
    const sub = await stripe().subscriptions.retrieve(business.platform_subscription_id);
    if (sub.status !== "canceled") {
      const price = await stripe().prices.create(planPriceData(plan.id));
      await stripe().subscriptions.update(sub.id, {
        items: [{ id: sub.items.data[0].id, price: price.id }],
        metadata: { businessId: business.id, planId: plan.id },
        proration_behavior: "create_prorations",
        cancel_at_period_end: false, // choosing a paid plan undoes a scheduled move to Starter
        ...(config.stripe.tax ? { automatic_tax: { enabled: true } } : {}),
      });
      setPlan(business.id, plan.id, "active", actor);
      setPlanEnd(business.id, null, actor);
      return { applied: true, url: returnUrl };
    }
  }

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: business.platform_customer_id ?? undefined,
    customer_email: business.platform_customer_id ? undefined : user.email,
    line_items: [{ quantity: 1, price_data: planPriceData(plan.id) as Stripe.Checkout.SessionCreateParams.LineItem.PriceData }],
    metadata: { businessId: business.id, planId: plan.id },
    subscription_data: { metadata: { businessId: business.id, planId: plan.id } },
    ...checkoutTax(!!business.platform_customer_id),
    success_url: `${returnUrl}?subscribed=1`,
    cancel_url: returnUrl,
  });
  return { applied: false, url: session.url! };
}

/**
 * New checkouts and plan changes pick up Stripe Tax automatically; this turns it on for subscriptions that started
 * before tax was switched on, so their next invoice includes tax. Stripe needs each customer's address for that;
 * any it can't do are reported (they're asked for it when they next update their card in Manage billing).
 */
export async function enableTaxOnSubscriptions() {
  if (!config.stripe.secretKey) throw badRequest("Stripe isn't connected");
  if (!config.stripe.tax) throw badRequest("Turn on \"Charge tax\" under Settings → Stripe first");
  const done: string[] = [];
  const failed: { business: string; error: string }[] = [];
  for (const b of all("SELECT id, name, platform_subscription_id FROM businesses WHERE platform_subscription_id IS NOT NULL ORDER BY name")) {
    try {
      const sub = await stripe().subscriptions.retrieve(b.platform_subscription_id);
      if (sub.status === "canceled") continue;
      if (!sub.automatic_tax?.enabled) await stripe().subscriptions.update(sub.id, { automatic_tax: { enabled: true } });
      done.push(b.name);
    } catch (err) {
      failed.push({ business: b.name, error: (err as Error).message });
    }
  }
  audit({ label: "superadmin" }, null, "billing.tax_enabled", { done: done.length, failed: failed.length });
  return { done, failed };
}

/** Undo a scheduled move to Starter: the paid plan carries on renewing as before. */
export async function keepPlan(business: Row, actor: Actor) {
  if (business.platform_subscription_id && config.stripe.secretKey) {
    await stripe().subscriptions.update(business.platform_subscription_id, { cancel_at_period_end: false });
  }
  setPlanEnd(business.id, null, actor);
}

function setPlanEnd(businessId: string, endsAt: string | null, actor: Actor) {
  const before = one("SELECT plan_ends_at FROM businesses WHERE id = ?", businessId)?.plan_ends_at ?? null;
  if (before === endsAt) return;
  run("UPDATE businesses SET plan_ends_at = ? WHERE id = ?", endsAt, businessId);
  audit(actor, businessId, endsAt ? "plan.ending" : "plan.end_cancelled", { endsAt });
}

/** When a subscription that's set to cancel will end: its cancel_at, else the end of the period already paid for. */
function subscriptionEnd(sub: Stripe.Subscription): string | null {
  if (!sub.cancel_at_period_end && !sub.cancel_at) return null;
  const seconds = sub.cancel_at ?? sub.items.data[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function planPriceData(planId: string) {
  const plan = getPlan(planId);
  return {
    currency: "usd",
    unit_amount: plan.monthlyPriceCents,
    recurring: { interval: "month" as const },
    product_data: { name: `Slotwise ${plan.name}`, tax_code: SAAS_TAX_CODE },
    tax_behavior: config.stripe.taxBehavior,
  };
}

/** Stripe's tax code for software as a service (business use). */
export const SAAS_TAX_CODE = "txcd_10103001";

/**
 * Checkout options when tax is on: Stripe Tax works out the tax from the billing address it collects, and
 * businesses can enter a tax ID (VAT, GST…) so it shows on their invoices.
 */
export function checkoutTax(hasCustomer: boolean): Partial<Stripe.Checkout.SessionCreateParams> {
  if (!config.stripe.tax) return {};
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    ...(hasCustomer ? { customer_update: { address: "auto", name: "auto" } } : {}),
  };
}

export async function openBillingPortal(business: Row) {
  if (!business.platform_customer_id) throw badRequest("No billing account yet — subscribe to a paid plan first");
  const portal = await stripe().billingPortal.sessions.create({
    customer: business.platform_customer_id,
    return_url: `${config.webUrl}/admin/${business.id}/billing`,
  });
  return portal.url;
}

/** Applies Stripe Billing webhook events for platform subscriptions. */
export function handleSubscriptionEvent(event: Stripe.Event) {
  const system = { label: "stripe-billing" };
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.mode !== "subscription" || !s.metadata?.businessId) return;
    run("UPDATE businesses SET platform_customer_id = ? WHERE id = ?", s.customer as string, s.metadata.businessId);
    setPlan(s.metadata.businessId, s.metadata.planId, "active", system, s.subscription as string);
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const businessId = sub.metadata?.businessId;
    if (!businessId || !one("SELECT 1 FROM businesses WHERE id = ?", businessId)) return;
    if (event.type === "customer.subscription.deleted" || sub.status === "canceled") {
      setPlan(businessId, "free", "active", system);
      setPlanEnd(businessId, null, system);
      run("UPDATE businesses SET platform_subscription_id = NULL WHERE id = ?", businessId);
    } else {
      setPlan(businessId, sub.metadata.planId ?? "pro", sub.status, system, sub.id);
      // Also catches cancelling (or un-cancelling) from the Stripe billing portal.
      setPlanEnd(businessId, subscriptionEnd(sub), system);
    }
  }
}
