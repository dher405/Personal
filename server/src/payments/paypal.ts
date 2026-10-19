import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { decryptJson } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import type { Row } from "../db.js";
import { toMajorUnits, type PaymentProvider } from "./types.js";

/** PayPal Orders v2 using the business's own PayPal REST app (client ID + secret from its Payments tab). */
export interface PayPalCreds { clientId: string; clientSecret: string; env: string }

export function credsFor(business: Row): PayPalCreds {
  const cfg = decryptJson<Record<string, string>>(business.payment_config);
  return { clientId: cfg.paypalClientId ?? "", clientSecret: cfg.paypalClientSecret ?? "", env: cfg.paypalEnv || "live" };
}

const baseUrl = (env: string) => (env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const tokens = new Map<string, { value: string; expiresAt: number }>();

export async function paypalAccessToken(creds: PayPalCreds) {
  if (!creds.clientId || !creds.clientSecret) throw badRequest("This business hasn't added its PayPal client ID and secret yet");
  const key = `${creds.env}:${creds.clientId}:${creds.clientSecret.slice(-6)}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const res = await fetch(`${baseUrl(creds.env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw badRequest(`PayPal sign-in failed: ${json.error_description ?? res.statusText}`);
  tokens.set(key, { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token as string;
}

export async function paypalFetch(path: string, init: { method?: string; body?: unknown } = {}, creds: PayPalCreds) {
  const res = await fetch(`${baseUrl(creds.env)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await paypalAccessToken(creds)}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json: any = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw badRequest(`PayPal error: ${json.details?.[0]?.description ?? json.message ?? res.statusText}`);
  return json;
}

export const paypalProvider: PaymentProvider = {
  name: "paypal",

  async createCheckout(req) {
    const creds = credsFor(req.business);
    const amount = { currency_code: req.currency, value: toMajorUnits(req.amountCents) };
    const order = await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: req.payment.id,
          description: req.description.slice(0, 127),
          amount,
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
    }, creds);
    const approve = order.links.find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    return { providerRef: order.id, checkoutUrl: approve.href };
  },

  async confirm(payment, business) {
    const creds = credsFor(business);
    let order = await paypalFetch(`/v2/checkout/orders/${payment.provider_ref}`, {}, creds);
    if (order.status === "APPROVED") {
      order = await paypalFetch(`/v2/checkout/orders/${payment.provider_ref}/capture`, { method: "POST" }, creds);
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    return { paid: order.status === "COMPLETED", providerPaymentId: capture?.id };
  },

  async refund(payment, business, amountCents) {
    if (!payment.provider_payment_id) throw badRequest("Payment has no PayPal capture to refund");
    await paypalFetch(`/v2/payments/captures/${payment.provider_payment_id}/refund`, {
      method: "POST",
      body: { amount: { currency_code: payment.currency, value: toMajorUnits(amountCents) } },
    }, credsFor(business));
  },
};
