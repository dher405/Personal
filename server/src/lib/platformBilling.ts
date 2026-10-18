import type Stripe from "stripe";
import { config } from "../config.js";
import { audit, one, run, Row } from "../db.js";
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
  const returnUrl = `${config.webUrl}/admin/${business.id}/billing`;

  if (plan.monthlyPriceCents === 0 || !config.stripe.secretKey) {
    if (business.platform_subscription_id && config.stripe.secretKey) {
      await stripe().subscriptions.cancel(business.platform_subscription_id);
    }
    setPlan(business.id, plan.id, "active", actor);
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
      });
      setPlan(business.id, plan.id, "active", actor);
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
    success_url: `${returnUrl}?subscribed=1`,
    cancel_url: returnUrl,
  });
  return { applied: false, url: session.url! };
}

function planPriceData(planId: string) {
  const plan = getPlan(planId);
  return {
    currency: "usd",
    unit_amount: plan.monthlyPriceCents,
    recurring: { interval: "month" as const },
    product_data: { name: `Slotwise ${plan.name}` },
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
      run("UPDATE businesses SET platform_subscription_id = NULL WHERE id = ?", businessId);
    } else {
      setPlan(businessId, sub.metadata.planId ?? "pro", sub.status, system, sub.id);
    }
  }
}
