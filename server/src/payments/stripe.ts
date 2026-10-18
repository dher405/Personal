import type { Row } from "../db.js";
import Stripe from "stripe";
import { config } from "../config.js";
import { decryptJson } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import type { PaymentProvider } from "./types.js";

let client: Stripe | null = null;
export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw badRequest("Stripe is not configured on this platform (STRIPE_SECRET_KEY)");
  client ??= new Stripe(config.stripe.secretKey);
  return client;
}

function accountFor(business: Row) {
  const { stripeAccountId } = decryptJson<{ stripeAccountId?: string }>(business.payment_config);
  if (!stripeAccountId) throw badRequest("This business has not connected a Stripe account yet");
  return stripeAccountId;
}

/**
 * Stripe Connect with direct charges: money lands in the business's own Stripe
 * account and the platform's cut is taken as an application fee.
 */
export const stripeProvider: PaymentProvider = {
  name: "stripe",

  async createCheckout(req) {
    const session = await stripe().checkout.sessions.create(
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
          application_fee_amount: req.platformFeeCents || undefined,
          metadata: { paymentId: req.payment.id },
        },
        metadata: { paymentId: req.payment.id },
        success_url: `${req.successUrl}${req.successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: req.cancelUrl,
      },
      { stripeAccount: accountFor(req.business) },
    );
    return { providerRef: session.id, checkoutUrl: session.url! };
  },

  async confirm(payment, business) {
    const session = await stripe().checkout.sessions.retrieve(payment.provider_ref, {}, { stripeAccount: accountFor(business) });
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    return { paid: session.payment_status === "paid", providerPaymentId: paymentIntent };
  },

  async refund(payment, business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no Stripe payment intent to refund");
    await stripe().refunds.create(
      { payment_intent: payment.provider_payment_id, amount: amountCents, refund_application_fee: true },
      { stripeAccount: accountFor(business) },
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
