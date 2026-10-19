process.env.NODE_ENV = "test";
process.env.PUBLIC_API_URL = "http://api.test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import Stripe from "stripe";

const { createApp } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { one, run, newId } = await import("../src/db.js");
const { config } = await import("../src/config.js");

let server: Server, base = "", superToken = "", owner = "", bid = "";
async function api(method: string, path: string, body?: unknown, token = superToken) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}
const field = (groups: any[], name: string) => groups.flatMap((g) => g.fields).find((f: any) => f.name === name);

before(async () => {
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  superToken = (await api("POST", "/api/auth/login", { email: "super@slotwise.test", password: "super1234" }, "")).body.token;
  owner = (await api("POST", "/api/auth/login", { email: "owner@demo.test", password: "demo1234" }, "")).body.token;
  bid = (await api("GET", "/api/auth/me", undefined, owner)).body.businesses[0].id;
});
after(() => server.close());

test("super admin saves keys on the Settings page; they work at once, encrypted, never shown back", async () => {
  assert.equal((await api("GET", "/api/auth/providers", undefined, "")).body.google, false);
  const saved = await api("PUT", "/api/super/settings", { values: { GOOGLE_CLIENT_ID: "abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-supersecretvalue" } });
  assert.equal(saved.status, 200);
  assert.equal((await api("GET", "/api/auth/providers", undefined, "")).body.google, true, "button appears without a redeploy");

  const secret = field(saved.body.groups, "GOOGLE_CLIENT_SECRET");
  assert.equal(secret.value, "");
  assert.equal(secret.preview, "••••alue");
  assert.equal(secret.source, "settings");
  assert.equal(field(saved.body.groups, "GOOGLE_CLIENT_ID").value, "abc.apps.googleusercontent.com");
  const raw = one("SELECT value FROM platform_settings WHERE key = 'cfg:GOOGLE_CLIENT_SECRET'")!.value;
  assert.ok(!raw.includes("supersecret"), "stored encrypted");

  const urls = (await api("GET", "/api/super/settings")).body.groups.find((g: any) => g.id === "google").urls;
  assert.deepEqual(urls.map((u: any) => u.url), ["http://api.test/api/auth/oauth/google/callback", "http://api.test/api/integrations/google/callback"]);

  await api("PUT", "/api/super/settings", { values: { GOOGLE_CLIENT_SECRET: "" } });
  assert.equal(config.oauth.google.clientSecret, "", "cleared");
  assert.equal((await api("GET", "/api/auth/providers", undefined, "")).body.google, false);
});

test("settings: validation, audit without values, super admin only", async () => {
  assert.equal((await api("PUT", "/api/super/settings", { values: { NOT_A_SETTING: "x" } })).status, 400);
  assert.equal((await api("PUT", "/api/super/settings", { values: { PAYPAL_ENV: "production" } })).status, 400);
  await api("PUT", "/api/super/settings", { values: { TWILIO_AUTH_TOKEN: "tok-123456789" } });
  const entry = one("SELECT details FROM audit_log WHERE action = 'settings.updated' ORDER BY rowid DESC LIMIT 1")!;
  assert.ok(entry.details.includes("TWILIO_AUTH_TOKEN") && !entry.details.includes("tok-123456789"));
  assert.equal((await api("GET", "/api/super/settings", undefined, owner)).status, 403);
  assert.equal((await api("PUT", "/api/super/settings", { values: { RESEND_API_KEY: "x" } }, owner)).status, 403);
  const t = await api("POST", "/api/super/settings/test/stripe");
  assert.deepEqual(t.body, { ok: false, message: "No secret key saved" });
});

test("a business can use its own Stripe keys; its webhook confirms payments with its own secret", async () => {
  const save = await api("PUT", `/api/admin/${bid}/payment-provider`, { provider: "stripe", secretKey: "sk_test_ownkey1234", webhookSecret: "whsec_business_secret" }, owner);
  assert.equal(save.status, 200);
  const sum = save.body.settings.payment_summary;
  assert.equal(sum.stripeKey, "••••1234");
  assert.equal(sum.webhooks.stripe, `http://api.test/api/webhooks/stripe/${bid}`);
  // Saving again with blank secrets keeps them.
  const again = await api("PUT", `/api/admin/${bid}/payment-provider`, { provider: "stripe", secretKey: "", webhookSecret: "" }, owner);
  assert.equal(again.body.settings.payment_summary.stripeKey, "••••1234");

  const b = one("SELECT * FROM bookings WHERE business_id = ? LIMIT 1", bid) ?? null;
  const pid = newId("pay");
  run("INSERT INTO payments (id, booking_id, business_id, provider, provider_ref, amount_cents, currency) VALUES (?,?,?,?,?,?,?)", pid, b?.id ?? null, bid, "stripe", "cs_test_123", 5000, "USD");
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_test_123", object: "checkout.session", payment_status: "paid", payment_intent: "pi_1", metadata: {} } } });
  const post = (secret: string) => fetch(`${base}/api/webhooks/stripe/${bid}`, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload,
  });
  assert.equal((await post("whsec_wrong")).status, 400);
  assert.equal((await post("whsec_business_secret")).status, 200);
  const p = one("SELECT * FROM payments WHERE id = ?", pid)!;
  assert.equal(p.status, "paid");
  assert.equal(p.provider_payment_id, "pi_1");
});

test("Square with the business's own keys and webhook signature key", async () => {
  const save = await api("PUT", `/api/admin/${bid}/payment-provider`, { provider: "square", accessToken: "EAAAsquare-token-9876", locationId: "LOC123", squareEnv: "sandbox", webhookKey: "sq-sig-key" }, owner);
  assert.equal(save.status, 200);
  assert.equal(save.body.settings.payment_summary.squareToken, "••••9876");
  const pid = newId("pay");
  run("INSERT INTO payments (id, business_id, provider, provider_ref, amount_cents, currency) VALUES (?,?,?,?,?,?)", pid, bid, "square", "order-77", 4000, "USD");
  const body = JSON.stringify({ type: "payment.updated", data: { object: { payment: { id: "sqpay-1", order_id: "order-77", status: "COMPLETED" } } } });
  const sig = createHmac("sha256", "sq-sig-key").update(`http://api.test/api/webhooks/square/${bid}` + body).digest("base64");
  const res = await fetch(`${base}/api/webhooks/square/${bid}`, { method: "POST", headers: { "Content-Type": "application/json", "x-square-hmacsha256-signature": sig }, body });
  assert.equal(res.status, 200);
  assert.equal(one("SELECT status FROM payments WHERE id = ?", pid)!.status, "paid");
});

test("PayPal uses the business's own app: both client ID and secret are required", async () => {
  assert.equal((await api("PUT", `/api/admin/${bid}/payment-provider`, { provider: "paypal", clientId: "only-id" }, owner)).status, 400);
  const ok = await api("PUT", `/api/admin/${bid}/payment-provider`, { provider: "paypal", clientId: "pp-id", clientSecret: "pp-secret-abcd", paypalEnv: "sandbox", webhookId: "WH-1" }, owner);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.payment_summary.paypalClientSecret, "••••abcd");
  assert.equal(ok.body.settings.payment_summary.webhooks.paypal, `http://api.test/api/webhooks/paypal/${bid}`);
});

test("no per-payment fee: payments record no platform fee and plans carry no fee", async () => {
  const plans = (await api("GET", "/api/super/plans")).body;
  assert.ok(plans.every((p: any) => p.platformFeeBps === undefined));
  assert.equal(one<{ n: number }>("SELECT COALESCE(SUM(platform_fee_cents),0) AS n FROM payments")!.n, 0);
});
