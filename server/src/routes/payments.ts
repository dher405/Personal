import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { config } from "../config.js";
import { one } from "../db.js";
import { confirmPayment, markPaid } from "../lib/bookings.js";
import { h } from "../lib/http.js";
import { handleSubscriptionEvent } from "../lib/platformBilling.js";
import { stripe } from "../payments/stripe.js";
import { paypalFetch } from "../payments/paypal.js";

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

paymentsRouter.post("/webhooks/stripe", raw, h(async (req, res) => {
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, config.stripe.webhookSecret);
  } catch {
    res.status(400).send("bad signature");
    return;
  }
  // Connect events (customer payments on a business's account) carry event.account.
  if (event.type === "checkout.session.completed" && event.account) {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.metadata?.paymentId && s.payment_status === "paid") {
      markPaid(s.metadata.paymentId, typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id);
    }
  } else {
    handleSubscriptionEvent(event);
  }
  return { received: true };
}));

paymentsRouter.post("/webhooks/square", raw, h(async (req, res) => {
  const signature = req.headers["x-square-hmacsha256-signature"] as string | undefined;
  const expected = createHmac("sha256", config.square.webhookSignatureKey).update(config.square.webhookUrl + req.body.toString("utf8")).digest("base64");
  if (!config.square.webhookSignatureKey || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(400).send("bad signature");
    return;
  }
  const event = JSON.parse(req.body.toString("utf8"));
  const sqPayment = event.data?.object?.payment;
  if (event.type === "payment.updated" && sqPayment?.status === "COMPLETED") {
    const payment = one("SELECT id FROM payments WHERE provider = 'square' AND provider_ref = ?", sqPayment.order_id);
    if (payment) markPaid(payment.id, sqPayment.id);
  }
  return { received: true };
}));

paymentsRouter.post("/webhooks/paypal", raw, h(async (req, res) => {
  const event = JSON.parse(req.body.toString("utf8"));
  const verification = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: req.headers["paypal-auth-algo"], cert_url: req.headers["paypal-cert-url"],
      transmission_id: req.headers["paypal-transmission-id"], transmission_sig: req.headers["paypal-transmission-sig"],
      transmission_time: req.headers["paypal-transmission-time"], webhook_id: config.paypal.webhookId, webhook_event: event,
    },
  });
  if (verification.verification_status !== "SUCCESS") {
    res.status(400).send("bad signature");
    return;
  }
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const payment = one("SELECT id FROM payments WHERE provider = 'paypal' AND provider_ref = ?", event.resource.id);
    if (payment) await confirmPayment(payment.id); // captures the order
  }
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = event.resource.supplementary_data?.related_ids?.order_id;
    const payment = orderId && one("SELECT id FROM payments WHERE provider = 'paypal' AND provider_ref = ?", orderId);
    if (payment) markPaid(payment.id, event.resource.id);
  }
  return { received: true };
}));
