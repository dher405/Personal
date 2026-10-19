import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { config } from "../config.js";
import { one } from "../db.js";
import { confirmPayment, markPaid } from "../lib/bookings.js";
import { h } from "../lib/http.js";
import { handleSubscriptionEvent } from "../lib/platformBilling.js";
import { applyPaidPackCheckout } from "../lib/usage.js";
import { stripe } from "../payments/stripe.js";
import { credsFor as paypalCredsFor, paypalFetch } from "../payments/paypal.js";
import { stripeFor } from "../payments/stripe.js";
import { decryptJson } from "../lib/crypto.js";

export const paymentsRouter = Router();

/** Customers land here after a hosted checkout (PayPal approval, mock). We verify with the provider, then redirect. */
paymentsRouter.get("/payments/:id/return", h(async (req, res) => {
  const params = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  try {
    await confirmPayment(req.params.id as string, params);
  } catch (err) {
    console.error("payment confirm failed", err);
  }
  const next = params.next?.startsWith(config.webUrl) ? params.next : config.webUrl;
  res.redirect(next);
}));

/** Called by the manage page after a Stripe/Square redirect to settle without waiting for the webhook. */
paymentsRouter.post("/payments/sync/:token", h(async (req) => {
  const booking = one("SELECT id FROM bookings WHERE manage_token = ?", req.params.token);
  if (!booking) return { ok: false };
  const pending = one("SELECT id FROM payments WHERE booking_id = ? AND status = 'pending' ORDER BY created_at DESC", booking.id);
  if (pending) await confirmPayment(pending.id);
  return { ok: true };
}));

// Webhooks need the raw body for signature checks, so they get their own parser.
const raw = express.raw({ type: "*/*", limit: "1mb" });

/** The platform's own Stripe account: plan subscriptions and pack purchases (what businesses pay you). */
paymentsRouter.post("/webhooks/stripe", raw, h(async (req, res) => {
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, config.stripe.webhookSecret);
  } catch {
    res.status(400).send("bad signature");
    return;
  }
  const session = event.data.object as Stripe.Checkout.Session;
  if (event.type === "checkout.session.completed" && session.metadata?.kind === "usage_pack") {
    if (session.payment_status === "paid") applyPaidPackCheckout(session.id, session.metadata as Record<string, string>);
  } else {
    handleSubscriptionEvent(event);
  }
  return { received: true };
}));

// ---------- Customer-payment webhooks: one address per business ----------
// Businesses take payments with their own Stripe / Square / PayPal accounts, so each gets its own address
// (shown on its Payments tab) and its signature is checked with that business's own secret.

function businessCfg(bid: string) {
  const business = one("SELECT * FROM businesses WHERE id = ?", bid);
  return business ? { business, cfg: decryptJson<Record<string, string>>(business.payment_config) } : null;
}

/** Only settle payments that belong to the business whose webhook this is. */
function markBusinessPaid(bid: string, where: string, ref: string, providerPaymentId?: string) {
  const payment = one(`SELECT id FROM payments WHERE business_id = ? AND ${where} = ?`, bid, ref);
  if (payment) markPaid(payment.id, providerPaymentId);
}

paymentsRouter.post("/webhooks/stripe/:bid", raw, h(async (req, res) => {
  const found = businessCfg(req.params.bid as string);
  if (!found?.cfg.stripeWebhookSecret || !found.cfg.stripeSecretKey) return void res.status(404).send("not configured");
  let event: Stripe.Event;
  try {
    event = stripeFor(found.business).webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, found.cfg.stripeWebhookSecret);
  } catch {
    return void res.status(400).send("bad signature");
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status === "paid") markBusinessPaid(found.business.id, "provider_ref", s.id, typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id);
  }
  return { received: true };
}));

paymentsRouter.post("/webhooks/square/:bid", raw, h(async (req, res) => {
  const found = businessCfg(req.params.bid as string);
  if (!found?.cfg.squareWebhookKey) return void res.status(404).send("not configured");
  const signature = req.headers["x-square-hmacsha256-signature"] as string | undefined;
  const url = `${config.apiUrl}/api/webhooks/square/${found.business.id}`;
  const expected = createHmac("sha256", found.cfg.squareWebhookKey).update(url + req.body.toString("utf8")).digest("base64");
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return void res.status(400).send("bad signature");
  }
  const event = JSON.parse(req.body.toString("utf8"));
  const sq = event.data?.object?.payment;
  if (event.type === "payment.updated" && sq?.status === "COMPLETED") markBusinessPaid(found.business.id, "provider_ref", sq.order_id, sq.id);
  return { received: true };
}));

paymentsRouter.post("/webhooks/paypal/:bid", raw, h(async (req, res) => {
  const found = businessCfg(req.params.bid as string);
  if (!found?.cfg.paypalWebhookId || !found.cfg.paypalClientId) return void res.status(404).send("not configured");
  const event = JSON.parse(req.body.toString("utf8"));
  const creds = paypalCredsFor(found.business);
  const verification = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: req.headers["paypal-auth-algo"], cert_url: req.headers["paypal-cert-url"],
      transmission_id: req.headers["paypal-transmission-id"], transmission_sig: req.headers["paypal-transmission-sig"],
      transmission_time: req.headers["paypal-transmission-time"], webhook_id: found.cfg.paypalWebhookId, webhook_event: event,
    },
  }, creds);
  if (verification.verification_status !== "SUCCESS") return void res.status(400).send("bad signature");
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const payment = one("SELECT id FROM payments WHERE business_id = ? AND provider_ref = ?", found.business.id, event.resource.id);
    if (payment) await confirmPayment(payment.id);
  }
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = event.resource.supplementary_data?.related_ids?.order_id;
    if (orderId) markBusinessPaid(found.business.id, "provider_ref", orderId, event.resource.id);
  }
  return { received: true };
}));
