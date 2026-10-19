import type { Row } from "../db.js";
import Stripe from "stripe";
import { config } from "../config.js";
import { decryptJson } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import type { PaymentProvider } from "./types.js";

// Clients are cached per key, so a key changed on the Settings page takes effect on the next call.
const clients = new Map<string, Stripe>();
const clientFor = (key: string) => {
  let c = clients.get(key);
  if (!c) clients.set(key, (c = new Stripe(key)));
  return c;
};

/** The platform's own Stripe account (plans, packs, Connect). */
export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw badRequest("Stripe isn't set up on the platform yet (Super admin → Settings)");
  return clientFor(config.stripe.secretKey);
}

/**
 * Which Stripe account takes this business's payments:
 * - their own keys (Payments tab): charges go straight to them; no platform fee is possible;
 * - otherwise Stripe Connect: direct charges on their connected account, platform fee as an application fee.
 */
export function stripeFor(business: Row): { client: Stripe; opts: Stripe.RequestOptions; own: boolean } {
  const cfg = decryptJson<{ stripeAccountId?: string; stripeSecretKey?: string }>(business.payment_config);
  if (cfg.stripeSecretKey) return { client: clientFor(cfg.stripeSecretKey), opts: {}, own: true };
  if (!cfg.stripeAccountId) throw badRequest("This business hasn't finished setting up Stripe");
  return { client: stripe(), opts: { stripeAccount: cfg.stripeAccountId }, own: false };
}

export const stripeProvider: PaymentProvider = {
  name: "stripe",

  async createCheckout(req) {
    const { client, opts, own } = stripeFor(req.business);
    const session = await client.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: req.customerEmail,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: req.currency.toLowerCase(),
            unit_amount: req.amountCents,
            product_data: { name: req.description },
          },
        }],
        payment_intent_data: {
          application_fee_amount: !own && req.platformFeeCents ? req.platformFeeCents : undefined,
          metadata: { paymentId: req.payment.id },
        },
        metadata: { paymentId: req.payment.id, businessId: req.business.id },
        success_url: `${req.successUrl}${req.successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: req.cancelUrl,
      },
      opts,
    );
    return { providerRef: session.id, checkoutUrl: session.url! };
  },

  async confirm(payment, business) {
    const { client, opts } = stripeFor(business);
    const session = await client.checkout.sessions.retrieve(payment.provider_ref, {}, opts);
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    return { paid: session.payment_status === "paid", providerPaymentId: paymentIntent };
  },

  async refund(payment, business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no Stripe payment intent to refund");
    const { client, opts, own } = stripeFor(business);
    await client.refunds.create(
      { payment_intent: payment.provider_payment_id, amount: amountCents, ...(own ? {} : { refund_application_fee: true }) },
      opts,
    );
  },
};

/** Express account + onboarding link so a business can accept payments through Stripe. */
export async function createStripeOnboarding(existingAccountId: string | undefined, email: string, returnUrl: string) {
  const accountId = existingAccountId ?? (await stripe().accounts.create({ type: "express", email })).id;
  const link = await stripe().accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: returnUrl,
    return_url: returnUrl,
  });
  return { accountId, url: link.url };
}
