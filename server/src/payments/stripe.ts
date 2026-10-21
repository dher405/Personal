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

/** The platform's own Stripe account: bills businesses for plans and packs. */
export function stripe(): Stripe {
  if (!config.stripe.secretKey) throw badRequest("Stripe isn't set up on the platform yet (Super admin → Settings)");
  return clientFor(config.stripe.secretKey);
}

/** The business's own Stripe account (keys from its Payments tab). Customer payments go straight to it. */
export function stripeFor(business: Row): Stripe {
  const cfg = decryptJson<{ stripeSecretKey?: string }>(business.payment_config);
  if (!cfg.stripeSecretKey) throw badRequest("This business hasn't added its Stripe keys yet");
  return clientFor(cfg.stripeSecretKey);
}

const stripeTaxOn = (business: Row) => !!decryptJson<{ stripeTax?: boolean }>(business.payment_config).stripeTax;

export const stripeProvider: PaymentProvider = {
  name: "stripe",

  async createCheckout(req) {
    const session = await stripeFor(req.business).checkout.sessions.create(
      {
        mode: "payment",
        customer_email: req.customerEmail,
        line_items: [{
          quantity: 1,
          price_data: {
            ...(stripeTaxOn(req.business) ? { tax_behavior: "exclusive" as const } : {}),
            currency: req.currency.toLowerCase(),
            unit_amount: req.amountCents,
            product_data: { name: req.description },
          },
        }],
        payment_intent_data: { metadata: { paymentId: req.payment.id } },
        // The business can have Stripe Tax add sales tax on top of its prices (it sets this up in its own Stripe account).
        ...(stripeTaxOn(req.business) ? { automatic_tax: { enabled: true }, billing_address_collection: "required" as const } : {}),
        metadata: { paymentId: req.payment.id, businessId: req.business.id },
        success_url: `${req.successUrl}${req.successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: req.cancelUrl,
      },
    );
    return { providerRef: session.id, checkoutUrl: session.url! };
  },

  async confirm(payment, business) {
    const session = await stripeFor(business).checkout.sessions.retrieve(payment.provider_ref);
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    return { paid: session.payment_status === "paid", providerPaymentId: paymentIntent };
  },

  async refund(payment, business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no Stripe payment intent to refund");
    await stripeFor(business).refunds.create({ payment_intent: payment.provider_payment_id, amount: amountCents });
  },
};
