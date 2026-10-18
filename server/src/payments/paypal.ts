import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { decryptJson } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import { toMajorUnits, type PaymentProvider } from "./types.js";

const baseUrl = () => (config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken() {
  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    throw badRequest("PayPal is not configured on this platform (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json: any = await res.json();
  if (!res.ok) throw badRequest(`PayPal auth failed: ${json.error_description ?? res.statusText}`);
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

export async function paypalFetch(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json: any = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw badRequest(`PayPal error: ${json.details?.[0]?.description ?? json.message ?? res.statusText}`);
  return json;
}

/**
 * PayPal Orders v2 as a platform: the platform app creates the order with the
 * business as payee. platform_fees requires PayPal partner (Commerce Platform) approval.
 */
export const paypalProvider: PaymentProvider = {
  name: "paypal",

  async createCheckout(req) {
    const { merchantId } = decryptJson<{ merchantId?: string }>(req.business.payment_config);
    if (!merchantId) throw badRequest("This business has not configured a PayPal merchant id yet");
    const amount = { currency_code: req.currency, value: toMajorUnits(req.amountCents) };
    const order = await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: req.payment.id,
          description: req.description.slice(0, 127),
          amount,
          payee: { merchant_id: merchantId },
          ...(req.platformFeeCents > 0
            ? { payment_instruction: { platform_fees: [{ amount: { currency_code: req.currency, value: toMajorUnits(req.platformFeeCents) } }] } }
            : {}),
        }],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: `${config.apiUrl}/api/payments/${req.payment.id}/return?next=${encodeURIComponent(req.successUrl)}`,
              cancel_url: req.cancelUrl,
              user_action: "PAY_NOW",
            },
          },
        },
      },
    });
    const approve = order.links.find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    return { providerRef: order.id, checkoutUrl: approve.href };
  },

  async confirm(payment) {
    let order = await paypalFetch(`/v2/checkout/orders/${payment.provider_ref}`);
    if (order.status === "APPROVED") {
      order = await paypalFetch(`/v2/checkout/orders/${payment.provider_ref}/capture`, { method: "POST" });
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    return { paid: order.status === "COMPLETED", providerPaymentId: capture?.id };
  },

  async refund(payment, _business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no PayPal capture to refund");
    await paypalFetch(`/v2/payments/captures/${payment.provider_payment_id}/refund`, {
      method: "POST",
      body: { amount: { currency_code: payment.currency, value: toMajorUnits(amountCents) } },
    });
  },
};
