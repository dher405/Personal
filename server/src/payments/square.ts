import type { Row } from "../db.js";
import { randomUUID } from "node:crypto";
import { decryptJson } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import type { PaymentProvider } from "./types.js";

const baseUrl = (cfg: SquareConfig) =>
  (cfg.squareEnv || "production") === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

interface SquareConfig { accessToken?: string; locationId?: string; squareEnv?: string; squareWebhookKey?: string }

export async function squareFetch(business: Row, path: string, init: { method?: string; body?: unknown } = {}) {
  const cfg = decryptJson<SquareConfig>(business.payment_config);
  if (!cfg.accessToken || !cfg.locationId) throw badRequest("This business has not configured Square credentials yet");
  const res = await fetch(`${baseUrl(cfg)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2025-01-23",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json: any = await res.json();
  if (!res.ok) throw badRequest(`Square error: ${json.errors?.[0]?.detail ?? res.statusText}`);
  return { json, cfg };
}

/**
 * Square hosted payment links, using the access token and location ID from the business's Payments tab.
 */
export const squareProvider: PaymentProvider = {
  name: "square",

  async createCheckout(req) {
    const cfg = decryptJson<SquareConfig>(req.business.payment_config);
    const { json } = await squareFetch(req.business, "/v2/online-checkout/payment-links", {
      method: "POST",
      body: {
        idempotency_key: req.payment.id,
        quick_pay: {
          name: req.description,
          price_money: { amount: req.amountCents, currency: req.currency },
          location_id: cfg.locationId,
        },
        checkout_options: {
          redirect_url: req.successUrl,
        },
        pre_populated_data: { buyer_email: req.customerEmail },
        payment_note: `slotwise:${req.payment.id}`,
      },
    });
    return { providerRef: json.payment_link.order_id, checkoutUrl: json.payment_link.url };
  },

  async confirm(payment, business) {
    const { json } = await squareFetch(business, `/v2/orders/${payment.provider_ref}`);
    const order = json.order;
    const tenderPaymentId = order?.tenders?.[0]?.payment_id;
    const paid = order?.state === "COMPLETED" || (order?.net_amount_due_money?.amount === 0 && !!tenderPaymentId);
    return { paid, providerPaymentId: tenderPaymentId };
  },

  async refund(payment, business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no Square payment id to refund");
    await squareFetch(business, "/v2/refunds", {
      method: "POST",
      body: {
        idempotency_key: randomUUID(),
        payment_id: payment.provider_payment_id,
        amount_money: { amount: amountCents, currency: payment.currency },
      },
    });
  },
};
